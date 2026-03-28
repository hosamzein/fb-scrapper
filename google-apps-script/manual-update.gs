const GITHUB_OWNER = 'hosamzein';
const GITHUB_REPO = 'fb-scrapper';
const GITHUB_WORKFLOW_ID = 'facebook-sync.yml';
const GITHUB_REF = 'main';

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
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    sheet.getRange('A1').setValue('Updating...');
    sheet.getRange('B1').setValue(new Date());

    const response = UrlFetchApp.fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/dispatches`,
      {
        method: 'post',
        contentType: 'application/json',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        payload: JSON.stringify({ ref: GITHUB_REF }),
        muteHttpExceptions: true,
      },
    );

    const statusCode = response.getResponseCode();
    if (statusCode !== 204) {
      throw new Error(
        `GitHub workflow dispatch failed: ${statusCode} ${response.getContentText()}`,
      );
    }

    sheet.getRange('A1').setValue('Update requested');
    sheet.getRange('B1').setValue(new Date());

    SpreadsheetApp.getActive().toast(
      'GitHub workflow triggered successfully.',
      'Facebook Sync',
      5,
    );
  } finally {
    lock.releaseLock();
  }
}
