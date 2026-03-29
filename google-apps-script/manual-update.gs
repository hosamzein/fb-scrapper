const GITHUB_OWNER = 'hosamzein';
const GITHUB_REPO = 'fb-scrapper';
const GITHUB_WORKFLOW_ID = 'facebook-sync.yml';
const GITHUB_REF = 'main';
const STATUS_SHEET_NAME = 'Facebook Sync Status';
const STATUS_HEADER_RANGE = 'A1:C1';
const STATUS_VALUE_RANGE = 'A2:C2';
const POLL_INTERVAL_MS = 10000;
const MAX_POLL_TIME_MS = 5 * 60 * 1000;

function getStatusSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(STATUS_SHEET_NAME);
  let created = false;

  if (!sheet) {
    sheet = spreadsheet.insertSheet(STATUS_SHEET_NAME);
    created = true;
  }

  const headers = [['status', 'last updated', 'run url']];
  const existingHeaders = sheet.getRange(STATUS_HEADER_RANGE).getValues();
  const needsInitialization =
    created ||
    headers[0].some((value, index) => existingHeaders[0][index] !== value);

  if (needsInitialization) {
    sheet.getRange(STATUS_HEADER_RANGE).setValues(headers);
    sheet.getRange(STATUS_VALUE_RANGE).clearContent();
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function setStatus(status, runUrl) {
  const sheet = getStatusSheet();
  sheet.getRange(STATUS_VALUE_RANGE).setValues([
    [status, new Date(), runUrl || ''],
  ]);
}

function githubRequest(path, githubToken, options) {
  const response = UrlFetchApp.fetch(`https://api.github.com${path}`, {
    method: options?.method || 'get',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: options?.payload ? JSON.stringify(options.payload) : undefined,
    muteHttpExceptions: true,
  });

  return response;
}

function getLatestWorkflowRun(githubToken) {
  const response = githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/runs?per_page=10&event=workflow_dispatch&branch=${encodeURIComponent(GITHUB_REF)}`,
    githubToken,
  );

  if (response.getResponseCode() !== 200) {
    throw new Error(
      `Failed to list workflow runs: ${response.getResponseCode()} ${response.getContentText()}`,
    );
  }

  const payload = JSON.parse(response.getContentText());
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return runs[0] || null;
}

function waitForWorkflowRun(githubToken, previousRunId) {
  const deadline = Date.now() + MAX_POLL_TIME_MS;

  while (Date.now() < deadline) {
    const run = getLatestWorkflowRun(githubToken);

    if (run && String(run.id) !== String(previousRunId || '')) {
      return run;
    }

    Utilities.sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out while waiting for GitHub to create the workflow run.');
}

function waitForWorkflowCompletion(githubToken, runId) {
  const deadline = Date.now() + MAX_POLL_TIME_MS;

  while (Date.now() < deadline) {
    const response = githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${runId}`,
      githubToken,
    );

    if (response.getResponseCode() !== 200) {
      throw new Error(
        `Failed to read workflow run: ${response.getResponseCode()} ${response.getContentText()}`,
      );
    }

    const run = JSON.parse(response.getContentText());
    if (run.status === 'completed') {
      return run;
    }

    Utilities.sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out while waiting for the workflow to finish.');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Facebook Sync')
    .addItem('Run Manual Update', 'runFacebookSyncFromSheet')
    .addToUi();
}

function runFacebookSyncFromSheet() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const githubToken = scriptProperties.getProperty('GITHUB_TOKEN');

  if (!githubToken) {
    setStatus('Missing GITHUB_TOKEN', '');
    throw new Error(
      'Missing GITHUB_TOKEN in Apps Script properties. Set it before running.',
    );
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    SpreadsheetApp.getActive().toast(
      'Another sync request is already in progress.',
      'Facebook Sync',
      5,
    );
    return;
  }

  try {
    setStatus('Starting update...', '');
    const previousRun = getLatestWorkflowRun(githubToken);

    const response = githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/dispatches`,
      githubToken,
      {
        method: 'post',
        payload: { ref: GITHUB_REF },
      },
    );

    const statusCode = response.getResponseCode();
    if (statusCode !== 204) {
      throw new Error(
        `GitHub workflow dispatch failed: ${statusCode} ${response.getContentText()}`,
      );
    }

    setStatus('Workflow requested', '');
    const queuedRun = waitForWorkflowRun(githubToken, previousRun?.id);
    setStatus('Workflow running...', queuedRun.html_url || '');
    const completedRun = waitForWorkflowCompletion(githubToken, queuedRun.id);

    if (completedRun.conclusion === 'success') {
      setStatus('Update completed', completedRun.html_url || '');
      SpreadsheetApp.getActive().toast(
        'GitHub workflow completed successfully.',
        'Facebook Sync',
        5,
      );
      return;
    }

    setStatus(
      `Update ${completedRun.conclusion || 'finished with unknown status'}`,
      completedRun.html_url || '',
    );
    throw new Error(
      `GitHub workflow finished with conclusion: ${completedRun.conclusion || 'unknown'}`,
    );
  } catch (error) {
    setStatus(`Update failed: ${error.message}`, '');
    SpreadsheetApp.getActive().toast(
      `Trigger failed: ${error.message}`,
      'Facebook Sync',
      8,
    );
    throw error;
  } finally {
    lock.releaseLock();
  }
}
