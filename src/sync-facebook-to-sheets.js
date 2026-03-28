import { google } from "googleapis";

const REQUIRED_ENV_VARS = [
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "GOOGLE_SHEETS_SPREADSHEET_ID",
];

for (const envName of REQUIRED_ENV_VARS) {
  if (!process.env[envName]) {
    throw new Error(`Missing required environment variable: ${envName}`);
  }
}

const facebookPageId = process.env.FACEBOOK_PAGE_ID || "463022726904933";
const facebookApiVersion = process.env.FACEBOOK_API_VERSION || "v24.0";
const facebookPageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const configuredSheetName = process.env.GOOGLE_SHEETS_SHEET_NAME;
const configuredSheetGid = process.env.GOOGLE_SHEETS_SHEET_GID;

function loadServiceAccount() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    const decoded = Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,
      "base64",
    ).toString("utf8");
    return JSON.parse(decoded);
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  throw new Error(
    "Missing required environment variable: GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  );
}

const serviceAccount = loadServiceAccount();

const headerRow = [
  "post content",
  "post url",
  "publishing timestamp",
  "image in post",
];

function extractImageUrl(post) {
  if (post.full_picture) {
    return post.full_picture;
  }

  const attachmentItems = post.attachments?.data || [];
  for (const attachment of attachmentItems) {
    const mediaImage = attachment.media?.image?.src;
    if (mediaImage) {
      return mediaImage;
    }

    const subattachments = attachment.subattachments?.data || [];
    for (const subattachment of subattachments) {
      const subattachmentImage = subattachment.media?.image?.src;
      if (subattachmentImage) {
        return subattachmentImage;
      }
    }
  }

  return "";
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

function buildFacebookUrl(nextUrl) {
  if (nextUrl) {
    return nextUrl;
  }

  const url = new URL(
    `https://graph.facebook.com/${facebookApiVersion}/${facebookPageId}/feed`,
  );
  url.searchParams.set(
    "fields",
    "message,created_time,permalink_url,full_picture,attachments",
  );
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", facebookPageAccessToken);
  return url.toString();
}

async function fetchFacebookPosts() {
  const posts = [];
  let nextUrl = null;

  while (true) {
    const url = buildFacebookUrl(nextUrl);
    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Facebook request failed: ${response.status} ${body}`);
    }

    const payload = await response.json();
    const data = Array.isArray(payload.data) ? payload.data : [];

    for (const post of data) {
      posts.push({
        content: post.message || "[Media Only Post]",
        postUrl: post.permalink_url || "",
        publishingTimestamp: formatTimestamp(post.created_time),
        imageInPost: extractImageUrl(post),
      });
    }

    if (!payload.paging?.next) {
      break;
    }

    nextUrl = payload.paging.next;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return posts.filter((post) => post.postUrl);
}

async function createSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

async function resolveSheetName(sheets) {
  if (configuredSheetName) {
    return configuredSheetName;
  }

  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties",
  });

  const sheetsList = metadata.data.sheets || [];

  if (configuredSheetGid) {
    const matchedSheet = sheetsList.find(
      (sheet) => String(sheet.properties?.sheetId) === String(configuredSheetGid),
    );

    if (!matchedSheet?.properties?.title) {
      throw new Error(
        `Could not find Google Sheet tab for gid ${configuredSheetGid}`,
      );
    }

    return matchedSheet.properties.title;
  }

  const firstSheetName = sheetsList[0]?.properties?.title;
  if (!firstSheetName) {
    throw new Error("Spreadsheet does not contain any sheets");
  }

  return firstSheetName;
}

async function ensureSheetHeaders(sheets, sheetName) {
  const range = `'${sheetName}'!A1:D1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const firstRow = existing.data.values?.[0] || [];
  const needsHeader = headerRow.some((value, index) => firstRow[index] !== value);

  if (!needsHeader) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [headerRow],
    },
  });
}

async function getExistingRows(sheets, sheetName) {
  const range = `'${sheetName}'!A2:D`;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = response.data.values || [];
  const rowByLink = new Map();
  const headerResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetName}'!A1:D1`,
  });
  const headers = headerResponse.data.values?.[0] || [];
  const urlColumnIndex =
    headers.indexOf("post url") >= 0 ? headers.indexOf("post url") : 1;

  values.forEach((row, index) => {
    const link = row[urlColumnIndex];
    if (link) {
      rowByLink.set(link, index + 2);
    }
  });

  return rowByLink;
}

function toRow(post) {
  return [
    post.content,
    post.postUrl,
    post.publishingTimestamp,
    post.imageInPost,
  ];
}

async function syncPostsToSheet(posts) {
  const sheets = await createSheetsClient();
  const sheetName = await resolveSheetName(sheets);
  await ensureSheetHeaders(sheets, sheetName);

  const rowByLink = await getExistingRows(sheets, sheetName);
  const appendRows = [];
  const imageUpdates = [];

  for (const post of posts) {
    const existingRowNumber = rowByLink.get(post.postUrl);

    if (existingRowNumber) {
      imageUpdates.push({
        range: `'${sheetName}'!D${existingRowNumber}`,
        values: [[post.imageInPost]],
      });
      continue;
    }

    appendRows.push(toRow(post));
  }

  if (imageUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: imageUpdates,
      },
    });
  }

  if (appendRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `'${sheetName}'!A:D`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: appendRows,
      },
    });
  }

  return {
    updatedImages: imageUpdates.length,
    appended: appendRows.length,
    sheetName,
  };
}

async function main() {
  const posts = await fetchFacebookPosts();
  const result = await syncPostsToSheet(posts);

  console.log(
    JSON.stringify(
      {
        fetched: posts.length,
        updatedImages: result.updatedImages,
        appended: result.appended,
        pageId: facebookPageId,
        sheetName: result.sheetName,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
