/**
 * @OnlyCurrentDoc
 */

// --- CONSTANTS ---
const PROCESSED_LABEL = "processed_attachments";
const ERROR_LABEL = "attachment_error";
const REVIEW_LABEL = "attachment_review";
const GMAIL_SEARCH_QUERY = "has:attachment -label:processed_attachments -label:attachment_error";
const INTAKE_FOLDER_NAME = "_intake";
const ROOT_FOLDER_NAME = "Documents";
const LLM_API_ENDPOINT = "https://api.openai.com/v1/chat/completions"; // Example for OpenAI
const SPREADSHEET_ID = ""; // TODO: Add your spreadsheet ID here
const SHEET_NAME = "Metadata";
const SHEET_HEADERS = [
  "File ID", "Original Filename", "Gmail Thread ID", "Sender",
  "Document Type", "Confidence", "Extracted JSON", "Folder Path",
  "Hash", "Timestamp", "Status"
];

const SUPPORTED_DOC_TYPES = {
  INVOICE: "invoice",
  RECEIPT: "receipt",
  RESUME: "resume",
  PITCH_DECK: "pitch_deck",
  CONTRACT: "contract",
  UNKNOWN: "unknown"
};

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" // .xlsx
];

// --- MAIN FUNCTION ---

/**
 * Main function to process emails, extract attachments, classify, and route them.
 */
function processInbox() {
  console.log("Starting attachment processing...");
  const scriptProperties = PropertiesService.getScriptProperties();
  const processedHashes = JSON.parse(scriptProperties.getProperty('processedHashes') || '{}');

  const threads = GmailApp.search(GMAIL_SEARCH_QUERY);
  console.log(`Found ${threads.length} threads to process.`);

  const intakeFolder = getOrCreateIntakeFolder();

  threads.forEach(thread => {
    try {
      const messages = thread.getMessages();
      messages.forEach(message => {
        const attachments = message.getAttachments({includeInlineImages: false});
        attachments.forEach(attachment => {
          const mimeType = attachment.getContentType();
          if (ALLOWED_MIME_TYPES.includes(mimeType)) {
            const hash = getHash(attachment);

            if (processedHashes[hash]) {
              console.log(`Skipping duplicate attachment: ${attachment.getName()} | Hash: ${hash}`);
              return; // Skip this attachment
            }

            console.log(`Processing unique attachment: ${attachment.getName()} | Hash: ${hash}`);
            const file = intakeFolder.createFile(attachment);
            console.log(`File saved to intake: ${file.getName()} | ID: ${file.getId()}`);

            const extractedText = extractText(file);
            console.log(`Extracted text length: ${extractedText.length}`);

            if (extractedText) {
              const classificationResult = classifyAndExtract(extractedText);
              console.log("Classification result:", JSON.stringify(classificationResult, null, 2));

              if (classificationResult) {
                const finalFile = routeDocument(file, classificationResult);

                if (finalFile) {
                  let status = "Processed";
                  // Apply Gmail labels based on confidence
                  if (classificationResult.confidence >= 0.85) {
                    thread.addLabel(GmailApp.getUserLabelByName(PROCESSED_LABEL));
                  } else if (classificationResult.confidence >= 0.6) {
                    thread.addLabel(GmailApp.getUserLabelByName(REVIEW_LABEL));
                    status = "Review";
                  }
                  logMetadata({
                    "File ID": finalFile.getId(),
                    "Original Filename": attachment.getName(),
                    "Gmail Thread ID": thread.getId(),
                    "Sender": message.getFrom(),
                    "Document Type": classificationResult.document_type,
                    "Confidence": classificationResult.confidence,
                    "Extracted JSON": JSON.stringify(classificationResult.fields),
                    "Folder Path": finalFile.getParents().next().getName(),
                    "Hash": hash,
                    "Timestamp": new Date(),
                    "Status": status,
                  });
                } else {
                  thread.addLabel(GmailApp.getUserLabelByName(ERROR_LABEL));
                  logMetadata({
                    "File ID": file.getId(),
                    "Original Filename": attachment.getName(),
                    "Gmail Thread ID": thread.getId(),
                    "Sender": message.getFrom(),
                    "Document Type": classificationResult.document_type,
                    "Confidence": classificationResult.confidence,
                    "Extracted JSON": JSON.stringify(classificationResult.fields),
                    "Folder Path": "N/A",
                    "Hash": hash,
                    "Timestamp": new Date(),
                    "Status": "Error: Routing Failed",
                  });
                }
              } else {
                thread.addLabel(GmailApp.getUserLabelByName(ERROR_LABEL));
                logMetadata({
                  "File ID": file.getId(),
                  "Original Filename": attachment.getName(),
                  "Gmail Thread ID": thread.getId(),
                  "Sender": message.getFrom(),
                  "Document Type": "N/A",
                  "Confidence": "N/A",
                  "Extracted JSON": "N/A",
                  "Folder Path": "N/A",
                  "Hash": hash,
                  "Timestamp": new Date(),
                  "Status": "Error: Classification Failed",
                });
              }
            }
            processedHashes[hash] = new Date().toISOString();
          }
        });
      });
    } catch (e) {
      console.error(`An unexpected error occurred for thread ${thread.getId()}: ${e.toString()}`);
      thread.addLabel(GmailApp.getUserLabelByName(ERROR_LABEL));
      logMetadata({
        "File ID": "N/A",
        "Original Filename": "N/A",
        "Gmail Thread ID": thread.getId(),
        "Sender": "N/A",
        "Document Type": "N/A",
        "Confidence": "N/A",
        "Extracted JSON": "N/A",
        "Folder Path": "N/A",
        "Hash": "N/A",
        "Timestamp": new Date(),
        "Status": `Error: ${e.toString()}`,
      });
    }
  });

  scriptProperties.setProperty('processedHashes', JSON.stringify(processedHashes));
  console.log("Attachment processing finished.");
}

// --- HELPER FUNCTIONS ---

/**
 * Gets or creates the daily intake folder in Google Drive.
 * @return {GoogleAppsScript.Drive.Folder} The target folder for the current day.
 */
function getOrCreateIntakeFolder() {
  const today = new Date();
  const year = today.getFullYear().toString();
  const month = ('0' + (today.getMonth() + 1)).slice(-2);
  const day = ('0' + today.getDate()).slice(-2);

  let root = DriveApp.getFoldersByName(INTAKE_FOLDER_NAME).hasNext()
    ? DriveApp.getFoldersByName(INTAKE_FOLDER_NAME).next()
    : DriveApp.createFolder(INTAKE_FOLDER_NAME);

  let yearFolder = root.getFoldersByName(year).hasNext()
    ? root.getFoldersByName(year).next()
    : root.createFolder(year);

  let monthFolder = yearFolder.getFoldersByName(month).hasNext()
    ? yearFolder.getFoldersByName(month).next()
    : yearFolder.createFolder(month);

  let dayFolder = monthFolder.getFoldersByName(day).hasNext()
    ? monthFolder.getFoldersByName(day).next()
    : monthFolder.createFolder(day);

  return dayFolder;
}

/**
 * Extracts text from a given file attachment.
 * @param {GoogleAppsScript.Drive.File} file The file to extract text from.
 * @return {string} The extracted text.
 */
function extractText(file) {
  const mimeType = file.getMimeType();
  let text = "";

  console.log(`Extracting text from ${file.getName()} (${mimeType})`);

  switch (mimeType) {
    case MimeType.GOOGLE_DOCS:
    case MimeType.GOOGLE_SLIDES:
    case MimeType.GOOGLE_SHEETS:
      // Logic for native Google Workspace files if needed
      break;

    case 'application/pdf':
      try {
        const tempDoc = Drive.Files.insert(
          { title: `[TEMP] ${file.getName()}`, mimeType: MimeType.GOOGLE_DOCS },
          file.getBlob(),
          { ocr: true }
        );
        const doc = DocumentApp.openById(tempDoc.id);
        text = doc.getBody().getText();
        Drive.Files.remove(tempDoc.id); // Clean up the temporary file
        console.log("Successfully extracted text from PDF.");
      } catch (e) {
        console.error(`Failed to extract text from PDF: ${e.toString()}`);
      }
      break;

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      try {
        const tempDoc = Drive.Files.insert(
          { title: `[TEMP] ${file.getName()}`, mimeType: MimeType.GOOGLE_DOCS },
          file.getBlob()
        );
        const doc = DocumentApp.openById(tempDoc.id);
        text = doc.getBody().getText();
        Drive.Files.remove(tempDoc.id); // Clean up the temporary file
        console.log("Successfully extracted text from Office document.");
      } catch (e) {
        console.error(`Failed to extract text from Office document: ${e.toString()}`);
      }
      break;

    default:
      console.log(`Unsupported MIME type for text extraction: ${mimeType}`);
  }

  return text;
}

/**
 * Sends extracted text to an LLM for classification and data extraction.
 * @param {string} text The text to analyze.
 * @return {object} The structured data from the LLM.
 */
function classifyAndExtract(text) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const llmApiKey = scriptProperties.getProperty('LLM_API_KEY');

  if (!llmApiKey) {
    console.error("LLM_API_KEY not found in script properties. Please set it.");
    return null;
  }

  const systemPrompt = `You are a document classification and data extraction system.
You must return STRICT JSON.
No explanations.
No markdown.
If uncertain, mark fields as null and lower confidence.`;

  const userPrompt = `Document text:
<<<
${text.substring(0, 15000)}
>>>

Tasks:
1. Classify document into one of: ${Object.values(SUPPORTED_DOC_TYPES).join(', ')}.
2. Extract fields relevant to the document type.
3. Provide a confidence score from 0.0 to 1.0.

Output JSON schema:
{
  "document_type": "",
  "confidence": 0.0,
  "fields": {
    ...
  }
}`;

  const payload = {
    model: "gpt-3.5-turbo", // Or your preferred model
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + llmApiKey,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    console.log("Sending request to LLM...");
    const response = UrlFetchApp.fetch(LLM_API_ENDPOINT, options);
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();

    if (responseCode === 200) {
      console.log("LLM response received successfully.");
      const parsedResponse = JSON.parse(responseBody);
      const content = JSON.parse(parsedResponse.choices[0].message.content);
      return content;
    } else {
      console.error(`LLM API request failed with code ${responseCode}: ${responseBody}`);
      return null;
    }
  } catch (e) {
    console.error(`Error calling LLM API: ${e.toString()}`);
    return null;
  }
}

/**
 * Routes a file to the appropriate folder based on its classification.
 * @param {GoogleAppsScript.Drive.File} file The file to route.
 * @param {object} classificationResult The result from the LLM.
 */
function routeDocument(file, classificationResult) {
  const { document_type, confidence, fields } = classificationResult;

  if (!document_type || typeof confidence !== 'number') {
    console.error("Invalid classification result:", classificationResult);
    return null; // Indicate failure
  }

  const rootFolder = DriveApp.getFoldersByName(ROOT_FOLDER_NAME).hasNext()
    ? DriveApp.getFoldersByName(ROOT_FOLDER_NAME).next()
    : DriveApp.createFolder(ROOT_FOLDER_NAME);

  let targetFolder;

  if (confidence < 0.6) {
    targetFolder = getOrCreateSubFolder(rootFolder, "Review");
  } else {
    targetFolder = getOrCreateSubFolder(rootFolder, getFolderName(document_type, fields));
  }

  const finalFile = file.moveTo(targetFolder);
  console.log(`File moved to: ${finalFile.getUrl()}`);
  return finalFile;
}

/**
 * Helper to get or create a subfolder.
 * @param {GoogleAppsScript.Drive.Folder} parentFolder The parent folder.
 * @param {string} folderName The name of the subfolder.
 * @return {GoogleAppsScript.Drive.Folder} The subfolder.
 */
function getOrCreateSubFolder(parentFolder, folderName) {
  const folders = parentFolder.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(folderName);
}

/**
 * Determines the folder name based on document type and extracted fields.
 * @param {string} docType The document type.
 * @param {object} fields The extracted fields.
 * @return {string} The folder name.
 */
function getFolderName(docType, fields) {
  switch (docType) {
    case SUPPORTED_DOC_TYPES.INVOICE:
      return `Invoices/${fields.vendor || 'Unknown Vendor'}`;
    case SUPPORTED_DOC_TYPES.RECEIPT:
      return `Receipts/${fields.merchant || 'Unknown Merchant'}`;
    case SUPPORTED_DOC_TYPES.RESUME:
      return 'Resumes';
    case SUPPORTED_DOC_TYPES.PITCH_DECK:
      return `Pitch Decks/${fields.company || 'Unknown Company'}`;
    case SUPPORTED_DOC_TYPES.CONTRACT:
      return `Contracts/${fields.counterparty || 'Unknown Counterparty'}`;
    default:
      return 'Unknown';
  }
}

/**
 * Logs the processing details to a Google Sheet.
 * @param {object} metadata The metadata to log.
 */
function logMetadata(metadata) {
  if (!SPREADSHEET_ID) {
    console.error("SPREADSHEET_ID is not set. Skipping metadata logging.");
    return;
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME);
      sheet.appendRow(SHEET_HEADERS);
    }

    const newRow = SHEET_HEADERS.map(header => metadata[header] || "");
    sheet.appendRow(newRow);
    console.log("Metadata logged successfully.");
  } catch (e) {
    console.error(`Error logging metadata: ${e.toString()}`);
  }
}

/**
 * Computes the SHA256 hash of a blob.
 * @param {GoogleAppsScript.Base.Blob} blob The blob to hash.
 * @return {string} The hex-encoded hash.
 */
function getHash(blob) {
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes());
  return hash.map(byte => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join('');
}
