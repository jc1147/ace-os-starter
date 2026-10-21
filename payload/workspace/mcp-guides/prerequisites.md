# Prerequisites Guide

Before using the workspace, you need a few tools installed. This guide walks through each one step by step.

The onboarding agent will help you through most of this live, but this document serves as a reference you can come back to.

---

## 1. VS Code

VS Code is the code editor where you'll interact with the workspace.

### Installation

1. Go to [code.visualstudio.com](https://code.visualstudio.com/)
2. Download the version for your operating system (macOS, Windows, or Linux)
3. **macOS**: Open the downloaded `.zip` file, drag **Visual Studio Code** to your Applications folder
4. **Windows**: Run the installer and follow the prompts
5. Open VS Code to verify it works

### First Launch (macOS)

- If macOS asks "Are you sure you want to open it?", click **Open**
- VS Code may ask to install additional tools — accept these prompts

---

## 2. Claude Code Extension

Claude Code is the AI assistant that powers the workspace. It runs as a VS Code extension.

### Installation

1. Open VS Code
2. Click the **Extensions** icon in the left sidebar (or press `Cmd+Shift+X` on Mac / `Ctrl+Shift+X` on Windows)
3. Search for **"Claude Code"**
4. Click **Install** on the official Anthropic extension
5. After installation, you'll see a Claude icon in the sidebar

### Activation

1. Click the Claude icon in the VS Code sidebar
2. Follow the prompts to sign in to your Anthropic account
3. Once signed in, you can start chatting with Claude in the panel

---

## 3. GitHub Account

GitHub is where your workspace files are stored and synced.

### Creating an Account

1. Go to [github.com](https://github.com/)
2. Click **Sign up**
3. Enter your email, create a password, and choose a username
4. Complete the verification steps
5. Choose the **Free** plan (it has everything you need)

### Settings to Configure

After creating your account:
1. Go to **Settings** > **Profile** and add your name
2. Go to **Settings** > **Emails** and verify your email address

---

## 4. GitHub CLI (`gh`)

The GitHub CLI lets Claude interact with GitHub on your behalf.

### Installation

**macOS (with Homebrew):**
```
brew install gh
```

**macOS (without Homebrew):**
1. Go to [cli.github.com](https://cli.github.com/)
2. Download the macOS installer
3. Open the downloaded file and follow the prompts

**Windows:**
```
winget install --id GitHub.cli
```

### Authentication

After installing, authenticate with your GitHub account:

1. Open Terminal (macOS) or Command Prompt (Windows)
2. Run: `gh auth login`
3. Choose **GitHub.com**
4. Choose **HTTPS** as the protocol
5. When asked to authenticate, choose **Login with a web browser**
6. Copy the one-time code shown in the terminal
7. A browser window opens — paste the code and authorize
8. Back in the terminal, you should see "Logged in as [username]"

### Verification

Run this to confirm it's working:
```
gh auth status
```

You should see your username and "Logged in to github.com".

---

## 5. Git (Version Control)

Git is usually pre-installed on macOS and most Linux systems.

### Check if Git is Installed

Open Terminal and run:
```
git --version
```

If you see a version number (e.g., `git version 2.39.2`), you're good.

### If Git is Not Installed

**macOS:** You'll be prompted to install Command Line Tools when you first run `git`. Click **Install** and wait for it to finish.

**Windows:** Download from [git-scm.com](https://git-scm.com/) and run the installer.

### Configure Your Identity

Git needs to know who you are for commit messages:

```
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

Use the same email as your GitHub account.

---

## 6. Permission Mode

Claude Code asks for approval before reading files, editing code, or running commands. Since this workspace runs agents that do a lot of file and terminal work, constant approval prompts can slow things down.

You can let Claude run without interruptions — all changes are tracked in Git, so you can always review and undo anything.

### Options

| Mode | What Happens | Best For |
|------|-------------|----------|
| **Recommended** | Claude runs without asking — you review changes in Git | Your own workspace where you control the code |
| **Ask each time** | Claude asks before each action | Shared machines or repos you don't fully trust |

The onboarding agent will configure this for you. Below is how to do it manually.

### CLI (per session)

```
claude --dangerously-skip-permissions
```

This lasts for the current session only.

### Project-Level (persists across sessions)

Create or edit `.claude/settings.json` in your workspace root:

```json
{
  "defaultMode": "bypassPermissions"
}
```

This travels with the repo — anyone who clones it gets the same setting.

### VS Code Extension

1. Open VS Code Settings (`Cmd+,` on Mac / `Ctrl+,` on Windows)
2. Search for **"Claude Code permission"**
3. Set **Initial Permission Mode** to `bypassPermissions`
4. Enable **Allow Dangerously Skip Permissions**

### Switching Back

To return to ask-each-time mode, remove `defaultMode` from `.claude/settings.json` or change it to `"default"`.

---

## Quick Checklist

Before starting the onboarding agent, verify:

- [ ] VS Code installed and opens
- [ ] Claude Code extension installed and signed in
- [ ] GitHub account created
- [ ] `gh auth login` completed successfully
- [ ] `git --version` returns a version number
- [ ] `git config user.name` returns your name
- [ ] Permission mode configured (recommended: bypass)

If all boxes are checked, you're ready to run the onboarding agent!
