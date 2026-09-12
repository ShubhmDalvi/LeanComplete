<p align="center">
  <img src="https://github.com/user-attachments/assets/60a3ed36-276e-43a4-8d6c-58883a76179b" alt="final" width="150" />
</p>

# LeanComplete

LeanComplete is a minimal, performance-focused VS Code extension for inline ghost-text autocomplete. It acts as a universal, lightweight client for any OpenAI-compatible Fill-in-the-Middle (FIM) API, allowing you to connect to Mistral's Codestral, DeepSeek Coder, or local offline inference engines running via Ollama or LM Studio.

There is no chat panel, no agent mode, and no telemetry. The extension strictly focuses on fast autocomplete with the same UX as GitHub Copilot (gray suggestion text, `Tab` to accept, `Alt+]` / `Alt+[` to cycle alternatives).

---

## Build and Install

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your machine.

### Steps
1. Clone this repository and navigate into the directory:
   ```bash
   git clone https://github.com/ShubhmDalvi/leancomplete
   cd leancomplete
   ```

2. Compile the extension package:
   ```bash
   npm install
   npx @vscode/vsce package --allow-missing-repository
   ```
   This will generate a file named `leancomplete-<version>.vsix` in your project root.

3. Install the package in VS Code:
   * Open VS Code and open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
   * Click the `...` menu in the top-right corner of the Extensions panel and select **Install from VSIX...**
   * Choose the newly generated `.vsix` file.
   * Reload the VS Code window when prompted.

---

## Configuration and Setup

LeanComplete groups your AI settings (Endpoint, Model, and API Key) into a single, unified setup flow to prevent configuration mismatches.

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **LeanComplete: Configure Provider...** (or click the status bar item and select **Configure Provider...**).
3. Select your provider from the list:
   * **Mistral / Codestral:** Automatically configures the official Codestral endpoint and default model, then prompts for your API key.
   * **DeepSeek:** Automatically configures the DeepSeek completions endpoint and default model, then prompts for your API key.
   * **Local (Ollama / LM Studio):** Automatically configures your local endpoint and default model, then configures a placeholder API key so the completion engine can activate offline.
   * **Custom:** Prompts you to manually enter a custom FIM endpoint, model ID, and API key.

---

## Key Features

* **Inline Completions:** Suggestions appear as you type. Press `Tab` to accept, or keep typing to ignore.
* **Manual On-Demand Trigger (`Alt + \`):** Bypasses the auto-suggest debounce and VS Code's global auto-suggest lock. This is ideal for a distraction-free "Zen Mode" where you only call the AI when stuck.
* **Status Bar Control Menu:** Click the status bar item to toggle the extension, configure your AI provider, clear the cache, cycle completion modes, and view local daily usage metrics.
* **Blocklist Management:** Mute completions for the active file type with **Disable for "[language]"** in the menu, or use the **Blocked Languages...** sub-menu to search and add any VS Code language ID to your permanent blocklist.
* **Output Channel Logging:** Select **Show Logs** from the menu to open a dedicated `LeanComplete` output channel for debugging API errors or tracking request latency.

---

## Core Mechanics

### Bracket Swallowing
To resolve common FIM duplicate bracket issues, the extension counts unmatched brackets in the suggestion and compares them with your editor's trailing suffix. If the suggestion includes a bracket the editor already has, the extension automatically overwrites it rather than duplicating it. Brackets inside string literals are ignored to prevent false-positive swallowing.

### Single-line vs. Multi-line Resolution
The default `auto` completion mode uses single-line completions when there is active code on the same line to your right, and allows multi-line completions only when the rest of the line is blank. Single-line requests use a lower token ceiling and a strict newline stop sequence to ensure faster response times.

---

## Extension Settings

Configure these options in your global `settings.json` file under the `leanComplete` namespace:

| Setting | Default | Description |
|---|---|---|
| `leanComplete.endpoint` | `https://codestral.mistral.ai/v1/fim/completions` | Target completions API endpoint. Supports cloud APIs and local providers. |
| `leanComplete.model` | `codestral-latest` | Model ID passed in the API request body. |
| `leanComplete.completionMode` | `auto` | Completion limit mode: `auto`, `single-line`, or `multi-line`. |
| `leanComplete.singleLineMaxTokens` | `48` | Hard token limit for single-line completions. |
| `leanComplete.multiLineMaxTokens` | `128` | Hard token limit for multi-line block completions. |
| `leanComplete.temperature` | `0` | Sampling temperature. `0` represents strict, predictable completions. |
| `leanComplete.maxPrefixLines` | `60` | Number of lines before the cursor to send as context. |
| `leanComplete.maxSuffixLines` | `25` | Number of lines after the cursor to send as context. |
| `leanComplete.enabled` | `true` | Master toggle for suggestions. |
| `leanComplete.debounceMs` | `300` | Typing pause delay in milliseconds before requesting completions. |
| `leanComplete.triggerCharacters` | `[".", "(", "=", ":", ","]` | Characters that apply the shorter debounce limit when typed. |
| `leanComplete.triggerCharacterDebounceMs` | `60` | Debounce limit applied immediately after typing a trigger character. |
| `leanComplete.requestTimeoutMs` | `8000` | Hard timeout limit before aborting and retrying a request. |
| `leanComplete.maxRetries` | `2` | Number of retries for timeouts, network drops, or 5xx server responses. |
| `leanComplete.cooldownMs` | `20000` | Fallback pause after a rate-limit (429) response if the server does not send a `Retry-After` header. |
| `leanComplete.numSuggestions` | `1` | Number of parallel completions to fetch (1–4). Note: Multiplies request volume. |
| `leanComplete.disabledLanguages` | `["plaintext", "markdown", "git-commit", "git-rebase", "scminput"]` | Language IDs where autocomplete is completely disabled. |
| `leanComplete.cacheEnabled` | `true` | Caches completions in-memory to instantly handle undos, backspaces, or line repeats. |

---

## Request Pipeline Lifecycle

When you pause typing or trigger a manual completion:
1. **Bail Checks:** Instantly aborts if LeanComplete is toggled off, if the file language is blocked, if there is an active selection, or if the file is completely empty.
2. **First-run Nudge:** If no configuration or API key is detected, the extension displays a one-time message prompting you to configure your provider, preventing silent failures.
3. **Cache Lookup:** Checks the in-memory cache for an exact match of the current model, completion mode, prefix, and suffix. If hit, the completion is displayed instantly with 0ms delay.
4. **Debounce Phase:** Waits for your typing pause (short debounce for trigger characters, standard debounce otherwise). If you type again during this window, the pending request is cancelled.
5. **Execution:** Dispatches parallel network requests with independent timeouts, error handlers, and backoff retries.
6. **Post-Processing:** Strips any trailing blank lines, trims suffix-overlap returned by the model, removes duplicate suggestions, and executes the bracket swallowing calculations.
7. **Rendering:** Resolves the final suggestion range and renders the ghost text in your editor.

---

## Development and Building

To package and compile your local modifications:

```bash
# Compile and output a new .vsix package
npx @vscode/vsce package --allow-missing-repository
```

This reads the manifest and compiles `leancomplete-<version>.vsix`. To apply the changes locally:
1. Open the Extensions panel, choose **Install from VSIX...**, and pick the newly built file.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **Developer: Reload Window** to load your fresh build.
