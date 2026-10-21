# Google Workspace MCP Setup

This guide walks you through connecting Claude Code to Google Workspace (Calendar, Gmail, Drive, Docs, Sheets, Slides).

## What You Get

Once configured, Claude can:
- Read and create calendar events
- Search and read emails
- Search, read, and create Drive files
- Read and edit Google Docs and Sheets
- Create presentations

## Prerequisites

- A Google account (personal or Workspace)
- Access to Google Cloud Console (free)
- About 15 minutes for initial setup

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top of the page
3. Click **New Project**
4. Name it something like "Claude Code MCP"
5. Click **Create**
6. Make sure your new project is selected in the dropdown

## Step 2: Enable APIs

1. In the Google Cloud Console, go to **APIs & Services** > **Library**
2. Search for and enable each of these APIs (click each one, then click **Enable**):
   - Google Calendar API
   - Gmail API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Slides API
   - Google Forms API (optional)
   - Google People API (optional, for contacts)

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Select **External** user type (unless you have Google Workspace admin access, then choose Internal)
3. Click **Create**
4. Fill in the required fields:
   - **App name**: "Claude Code MCP"
   - **User support email**: Your email
   - **Developer contact email**: Your email
5. Click **Save and Continue**
6. On the **Scopes** page, click **Add or Remove Scopes**
7. Add these scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/documents`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/presentations`
8. Click **Save and Continue**
9. On the **Test users** page, add your Google email address
10. Click **Save and Continue**

## Step 4: Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Choose **Desktop app** as the application type
4. Name it "Claude Code" or similar
5. Click **Create**
6. A dialog shows your Client ID and Client Secret — click **Download JSON**
7. Save this file — you'll need it in the next step

## Step 5: Set Up the MCP Server

1. Create the credentials directory:
   ```
   mkdir -p ~/.google_workspace_mcp/credentials
   ```

2. Move your downloaded credentials file:
   ```
   mv ~/Downloads/client_secret_*.json ~/.google_workspace_mcp/credentials/oauth_creds.json
   ```

3. Add the server to your `~/.claude.json`:
   ```json
   {
     "mcpServers": {
       "google-workspace": {
         "type": "stdio",
         "command": "/full/path/to/uvx",
         "args": [
           "--from", "google-workspace-mcp",
           "google-workspace-mcp"
         ],
         "env": {
           "CREDENTIALS_DIR": "~/.google_workspace_mcp/credentials",
           "GOOGLE_WORKSPACE_MCP_USERS": "your.email@gmail.com"
         }
       }
     }
   }
   ```

   **Finding the full path to `uvx`:**
   - Open Terminal and run: `which uvx`
   - Use the full path shown (e.g., `/Users/yourname/.local/bin/uvx`)
   - If `uvx` is not installed, install it first: `pip install uv` or `pipx install uv`

## Step 6: First Run Authentication

1. Restart Claude Code (close and reopen, or use the command palette)
2. Ask Claude something that uses Google: "What's on my calendar today?"
3. A browser window will open asking you to sign in to Google
4. Sign in with the Google account you added as a test user
5. Grant all the requested permissions
6. You'll see a "success" message — close the browser tab
7. Claude should now have access to your Google Workspace

## Troubleshooting

### "Access blocked: This app's request is invalid"
- Make sure you added yourself as a test user in the OAuth consent screen
- Double-check that the OAuth client type is "Desktop app"

### "Token expired" or authentication stops working
- Delete the token file: `rm ~/.google_workspace_mcp/credentials/token_*.json`
- Restart Claude Code — it will prompt you to re-authenticate

### "API not enabled" errors
- Go back to Step 2 and make sure all required APIs are enabled
- It can take a few minutes for newly enabled APIs to become available

### Server not appearing in Claude Code
- Check that `~/.claude.json` has valid JSON (no trailing commas, proper quotes)
- Verify the `uvx` path is correct and the package is installed
- Restart Claude Code after any configuration changes

## Security Notes

- OAuth tokens are stored locally in `~/.google_workspace_mcp/credentials/`
- Tokens are scoped to only the APIs you enabled
- You can revoke access at any time from [Google Security Settings](https://myaccount.google.com/permissions)
- The OAuth credentials file (`oauth_creds.json`) should be kept private — do not commit it to version control
