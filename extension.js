// LeanComplete — minimal inline completion provider backed by
// Mistral's LeanComplete FIM (fill-in-the-middle) endpoint.
//
// No chat panel, no telemetry, no bloat. Just ghost-text completions,
// same UX as Copilot: suggestion appears greyed out, Tab to accept,
// Alt+] / Alt+[ to cycle alternatives when numSuggestions > 1.

const vscode = require('vscode');

const SECRET_KEY = 'leanComplete.apiKey';
const USAGE_KEY = 'leanComplete.dailyUsage';
const NO_KEY_NUDGE_KEY = 'leanComplete.noKeyNudgeShown';
const CACHE_MAX_ENTRIES = 300;
const COMPLETION_MODES = ['auto', 'single-line', 'multi-line'];

// ---- module-level state (shared across every provider invocation) ----
let enabled = true;
let statusBarItem;
let outputChannel;
let context; // set in activate(), read by helpers
let activeRequestCount = 0;
let cooldownUntil = 0;
let cooldownNotified = false;
let invalidKeyNotified = false;
let noKeyNudgeShown = false;
let lastLatencyMs = null;
let tickHandle = null;  
let lastError = null;
const responseCache = new Map(); // key -> string[] of completions

function activate(ctx) {
  context = ctx;

  outputChannel = vscode.window.createOutputChannel('LeanComplete');
  context.subscriptions.push(outputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'leanComplete.showMenu';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();
  updateStatusBar();

  // Tick once a second: cheap, and it's what lets the cooldown countdown
  // and spinner state stay visually accurate without extra event wiring.
  tickHandle = setInterval(() => {
    if (cooldownUntil && Date.now() >= cooldownUntil) {
      cooldownUntil = 0;
      cooldownNotified = false;
    }
    updateStatusBar();
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tickHandle) });

  context.subscriptions.push(
    vscode.commands.registerCommand('leanComplete.configureProvider', async () => {
      const providers = [
        { label: '$(server) Mistral / Codestral', endpoint: 'https://codestral.mistral.ai/v1/fim/completions', model: 'codestral-latest' },
        { label: '$(server) DeepSeek', endpoint: 'https://api.deepseek.com/beta/completions', model: 'deepseek-coder' },
        { label: '$(device-desktop) Local (Ollama / LM Studio)', endpoint: 'http://localhost:11434/v1/completions', model: 'deepseek-coder' },
        { label: '$(gear) Custom', description: 'Manually enter endpoint and model' }
      ];
      
      const pick = await vscode.window.showQuickPick(providers, { placeHolder: 'Select your AI Provider' });
      if (!pick) return;

      const config = vscode.workspace.getConfiguration('leanComplete');
      let endpoint = pick.endpoint;
      let model = pick.model;

      if (pick.label.includes('Custom')) {
        endpoint = await vscode.window.showInputBox({ prompt: 'Enter custom FIM endpoint URL', value: config.get('endpoint'), ignoreFocusOut: true });
        if (!endpoint) return;
        model = await vscode.window.showInputBox({ prompt: 'Enter custom model ID', value: config.get('model'), ignoreFocusOut: true });
        if (!model) return;
      }

      await config.update('endpoint', endpoint.trim(), vscode.ConfigurationTarget.Global);
      await config.update('model', model.trim(), vscode.ConfigurationTarget.Global);

      const key = await vscode.window.showInputBox({
        prompt: `Enter API key for ${pick.label.replace(/\$\([^)]*\)\s*/, '')} (leave blank if local/offline)`,
        password: true,
        ignoreFocusOut: true
      });
      
      if (key !== undefined) {
        // If local and left blank, save dummy key so the engine activates
        const finalKey = key.trim() || 'dummy-local-key';
        await context.secrets.store(SECRET_KEY, finalKey);
        invalidKeyNotified = false;
        lastError = null; // Clear any previous mismatch errors
        updateStatusBar();
        vscode.window.showInformationMessage(`LeanComplete perfectly configured for ${pick.label.replace(/\$\([^)]*\)\s*/, '')}!`);
      }
    }),
    vscode.commands.registerCommand('leanComplete.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('API key cleared.');
    }),
	vscode.commands.registerCommand('leanComplete.clearCache', () => {
    responseCache.clear();
    vscode.window.showInformationMessage('Completion cache cleared.');
	}),
    vscode.commands.registerCommand('leanComplete.toggle', () => {
      enabled = !enabled;
      updateStatusBar();
      vscode.window.showInformationMessage(`LeanComplete ${enabled ? 'enabled' : 'disabled'}`);
    }),
    vscode.commands.registerCommand('leanComplete.triggerSuggest', () => {
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),
    vscode.commands.registerCommand('leanComplete.cycleCompletionMode', async () => {
        const config = vscode.workspace.getConfiguration('leanComplete');
        const current = config.get('completionMode');
        const pick = await vscode.window.showQuickPick(
            COMPLETION_MODES.map(mode => ({
                label: mode,
                description: mode === current ? '(current)' : '',
            })),
            {
                placeHolder: 'Select completion mode',
            }
        );
        if (pick && pick.label !== current) {
            await config.update('completionMode', pick.label, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`LeanComplete completion mode: ${pick.label}`);
        }
    }),
    vscode.commands.registerCommand('leanComplete.showUsageStats', () => {
      const stats = getUsageStats();
      const latency = lastLatencyMs != null ? `${lastLatencyMs}ms` : 'n/a';
      const errLine = lastError ? ` · last error: ${lastError}` : '';
      vscode.window.showInformationMessage(
        `LeanComplete today: ${stats.requests} request(s), ~${stats.tokens} tokens · last latency: ${latency}${errLine}`
      );
    }),
    vscode.commands.registerCommand('leanComplete.showLogs', () => {
      outputChannel.show();
    }),
    vscode.commands.registerCommand('leanComplete.showMenu', async () => {
      const config = vscode.workspace.getConfiguration('leanComplete');

      // Check if API key is set so we can display its status
      const apiKey = await context.secrets.get(SECRET_KEY);
      const keySet = !!apiKey;

      // Context for the per-language quick-toggle item below.
      const activeEditor = vscode.window.activeTextEditor;
      const activeLanguageId = activeEditor ? activeEditor.document.languageId : null;
      const disabledLanguages = config.get('disabledLanguages') || [];
      const isActiveLanguageDisabled = activeLanguageId ? disabledLanguages.includes(activeLanguageId) : false;

      const picked = await vscode.window.showQuickPick(
        [
          { label: enabled ? '$(circle-slash) Disable' : '$(symbol-snippet) Enable', action: 'toggle' },
          { 
            label: '$(server-environment) Configure Provider...', 
            description: `${config.get('model')} ${keySet ? '$(check)' : '$(warning)'}`, 
            action: 'configureProvider' 
          },
          { label: '$(trash) Clear API Key', action: 'clearKey' },
          { label: '$(trash) Clear Cache', action: 'clearCache' },
          { label: '$(list-selection) Completion Mode', description: config.get('completionMode'), action: 'cycleMode' },
          { label: '$(graph) Usage & Latency', action: 'usage' },
          { label: '$(output) Show Logs', action: 'showLogs' },
          ...(activeLanguageId ? [{
            label: isActiveLanguageDisabled
              ? `$(check) Enable for "${activeLanguageId}"`
              : `$(circle-slash) Disable for "${activeLanguageId}"`,
            action: 'toggleLanguage'
          }] : []),
		  { label: '$(list-unordered) Blocked Languages...', action: 'manageLanguages' },
        ],
        { placeHolder: 'LeanComplete' }
      );
      if (!picked) return;

      if (picked.action === 'toggleLanguage') {
        const updated = isActiveLanguageDisabled
          ? disabledLanguages.filter(lang => lang !== activeLanguageId)
          : [...disabledLanguages, activeLanguageId];
        await config.update('disabledLanguages', updated, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          `LeanComplete ${isActiveLanguageDisabled ? 'enabled' : 'disabled'} for "${activeLanguageId}"`
        );
        return;
      }
	  
	  if (picked.action === 'manageLanguages') {
  const disabled = config.get('disabledLanguages') || [];

  // Build a secondary sub-menu
  const subMenuItems = [
    { label: '$(add) Add Language to Blocklist...', action: 'add' },
    ...disabled.map(lang => ({
      label: lang,
      description: '$(trash) Click to unblock',
      action: 'unblock'
    }))
  ];

  const pickedSub = await vscode.window.showQuickPick(subMenuItems, {
    placeHolder: 'Manage Blocked Languages'
  });
  if (!pickedSub) return;

  if (pickedSub.action === 'add') {
    // Fetch all recognized language IDs in the user's VS Code instance
    const allLanguages = await vscode.languages.getLanguages();
    
    // Show a searchable list of actual languages
    const targetLang = await vscode.window.showQuickPick(allLanguages, {
      placeHolder: 'Search and select a language to block'
    });
    
    if (targetLang && !disabled.includes(targetLang)) {
      await config.update('disabledLanguages', [...disabled, targetLang], vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Blocked suggestions for "${targetLang}"`);
    }
  } else if (pickedSub.action === 'unblock') {
    // Remove the language from settings
    const updated = disabled.filter(lang => lang !== pickedSub.label);
    await config.update('disabledLanguages', updated, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Unblocked suggestions for "${pickedSub.label}"`);
  }
  return; // Exits the showMenu handler cleanly
}

      const commandMap = {
        toggle: 'leanComplete.toggle',
        configureProvider: 'leanComplete.configureProvider',
        clearKey: 'leanComplete.clearApiKey',
        clearCache: 'leanComplete.clearCache',
        cycleMode: 'leanComplete.cycleCompletionMode',
        usage: 'leanComplete.showUsageStats',
        showLogs: 'leanComplete.showLogs'
      };
      vscode.commands.executeCommand(commandMap[picked.action]);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, { provideInlineCompletionItems })
  );
}

// ---------------------------------------------------------------------
// Core provider
// ---------------------------------------------------------------------

async function provideInlineCompletionItems(document, position, ctx, token) {
  if (!enabled) return { items: [] };

  const isManualTrigger = ctx && ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

  // Respect VS Code's own global inline-suggest toggle too — but only for
  // automatic (typing-driven) triggers. A manual trigger (command/keybinding)
  // should still work even if the user has turned auto-suggest off.
  if (!isManualTrigger && vscode.workspace.getConfiguration('editor').get('inlineSuggest.enabled') === false) {
    return { items: [] };
  }

  const config = vscode.workspace.getConfiguration('leanComplete');
  if (!config.get('enabled')) return { items: [] };

  const disabledLanguages = config.get('disabledLanguages') || [];
  if (disabledLanguages.includes(document.languageId)) return { items: [] };

  // Don't interrupt an active selection (e.g. mid drag-select or multi-cursor block edit).
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document === document && !editor.selection.isEmpty) {
    return { items: [] };
  }

  // Minimum-context guard: skip only when the file is genuinely empty —
  // a blank line surrounded by real code is exactly where autocomplete
  // is most useful, so that case is intentionally NOT skipped here.
  if (document.getText().trim().length === 0) return { items: [] };

  const apiKey = await context.secrets.get(SECRET_KEY);
  if (!apiKey) {
    if (!noKeyNudgeShown) void maybeShowNoKeyNudge();
    return { items: [] };
  }

  const { prefix, suffix } = getContext(document, position, config);
  const lineMode = resolveLineMode(suffix, config);
  const numSuggestions = clamp(Number(config.get('numSuggestions')) || 1, 1, 4);
  const cacheEnabled = config.get('cacheEnabled');
  const cacheKey = buildCacheKey(config, prefix, suffix, numSuggestions, lineMode);

  if (cacheEnabled && responseCache.has(cacheKey)) {
    return { items: toItems(responseCache.get(cacheKey), position, document, prefix, suffix) };
  }

  const debounceMs = getDebounceMs(document, position, config);
  await sleepCancelable(debounceMs, token);
  if (token.isCancellationRequested) return { items: [] };

  if (Date.now() < cooldownUntil) return { items: [] };

  activeRequestCount++;
  updateStatusBar();
  try {
    const { completions, usageList, elapsed } = await getCompletions({
      config,
      apiKey,
      prefix,
      suffix,
      numSuggestions,
      lineMode,
      token
    });

    if (token.isCancellationRequested || completions.length === 0) return { items: [] };

    if (cacheEnabled) setCache(cacheKey, completions);
    if (usageList.length > 0) {
      lastLatencyMs = elapsed;
      lastError = null;
      recordUsage(usageList);
    }

    return { items: toItems(completions, position, document, prefix, suffix) };
  } finally {
    activeRequestCount--;
    updateStatusBar();
  }
}

async function maybeShowNoKeyNudge() {
  noKeyNudgeShown = true; // set immediately so rapid keystrokes don't pile up calls
  if (context.globalState.get(NO_KEY_NUDGE_KEY)) return;
  await context.globalState.update(NO_KEY_NUDGE_KEY, true);
  const pick = await vscode.window.showInformationMessage(
    'LeanComplete needs an AI provider & API key before it can suggest completions.',
    'Configure Provider'
  );
  if (pick === 'Configure Provider') {
    vscode.commands.executeCommand('leanComplete.configureProvider');
  }
}


// --- THE ULTIMATE toItems FUNCTION ---
function toItems(completions, position, document, prefix, suffix) {
  return completions.map(text => {
    
    // 1. Calculate unmatched closing characters in the completion text
    let unmatched = { ')': 0, ']': 0, '}': 0, '"': 0, "'": 0, '`': 0 };
    let stringChar = null; // quote char we're currently inside, or null if not in a string
    let prevChar = null;
    for (let char of text) {
      if (stringChar) {
        // Inside a string literal: only an unescaped matching quote ends it.
        // Brackets inside the string are intentionally ignored.
        if (char === stringChar && prevChar !== '\\') {
          unmatched[stringChar] ^= 1;
          stringChar = null;
        }
      } else if (char === '"' || char === "'" || char === '`') {
        unmatched[char] ^= 1;
        stringChar = char;
      } else if (char === '(') unmatched[')']--;
      else if (char === ')') unmatched[')']++;
      else if (char === '[') unmatched[']']--;
      else if (char === ']') unmatched[']']++;
      else if (char === '{') unmatched['}']--;
      else if (char === '}') unmatched['}']++;
      prevChar = char;
    }

    // 2. See if the characters right after our cursor match the unmatched brackets
    let consumeCount = 0;
    for (let i = 0; i < suffix.length; i++) {
      let char = suffix[i];
      if (unmatched[char] !== undefined && unmatched[char] > 0) {
        unmatched[char]--; // We matched it!
        consumeCount++;    // Swallow this character from the document
      } else {
        break; 
      }
    }

    // 3. Fallback: check for exact literal overlap at the very start 
    let startOverlap = 0;
    while (
      startOverlap < text.length &&
      startOverlap < suffix.length &&
      text[startOverlap] === suffix[startOverlap]
    ) {
      startOverlap++;
    }

    let range = new vscode.Range(position, position);
    let overlap = Math.max(consumeCount, startOverlap);
    
    // 4. Extend the replacement range so VS Code deletes the duplicate bracket
    if (overlap > 0) {
      const offset = document.offsetAt(position);
      const endPos = document.positionAt(offset + overlap);
      range = new vscode.Range(position, endPos);
    }

    return new vscode.InlineCompletionItem(text, range);
  });
}

function getContext(document, position, config) {
  const maxPrefixLines = config.get('maxPrefixLines');
  const maxSuffixLines = config.get('maxSuffixLines');

  const startLine = Math.max(0, position.line - maxPrefixLines);
  const endLine = Math.min(document.lineCount - 1, position.line + maxSuffixLines);

  const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
  const suffixRange = new vscode.Range(
    position.line,
    position.character,
    endLine,
    document.lineAt(endLine).text.length
  );

  return {
    prefix: document.getText(prefixRange),
    suffix: document.getText(suffixRange)
  };
}

// ---------------------------------------------------------------------
// Completion-mode resolution (single-line vs multi-line)
// ---------------------------------------------------------------------

// Whether this request may span multiple lines. Note the hard safety rule:
// if there's real content after the cursor on the current line, a
// multi-line completion would splice newlines into the middle of that
// line and corrupt it — so that case is ALWAYS forced to single-line,
// regardless of the completionMode setting.
function resolveLineMode(suffix, config) {
  const newlineIdx = suffix.indexOf('\n');
  const restOfCurrentLine = newlineIdx === -1 ? suffix : suffix.slice(0, newlineIdx);
  const hasContentAfterCursorOnLine = restOfCurrentLine.trim().length > 0;

  if (hasContentAfterCursorOnLine) return 'single-line';

  const mode = config.get('completionMode');
  if (mode === 'single-line') return 'single-line';
  return 'multi-line'; // 'multi-line' setting, or 'auto' with a blank rest-of-line
}

function getModeParams(lineMode, config) {
  if (lineMode === 'single-line') {
    return { maxTokens: config.get('singleLineMaxTokens'), stop: ['\n'] };
  }
  return { maxTokens: config.get('multiLineMaxTokens'), stop: ['\n\n\n'] };
}

// Trigger characters (., (, =, etc.) get a much shorter debounce than
// ordinary typing, since a pause right after one is a strong signal
// you're waiting on a suggestion rather than mid-word.
function getDebounceMs(document, position, config) {
  if (position.character === 0) return config.get('debounceMs');
  const charBefore = document.getText(new vscode.Range(position.translate(0, -1), position));
  const triggerChars = config.get('triggerCharacters') || [];
  if (triggerChars.includes(charBefore)) {
    return config.get('triggerCharacterDebounceMs');
  }
  return config.get('debounceMs');
}

// ---------------------------------------------------------------------
// Fetching (timeout, retry/backoff, 429 cooldown, multi-suggestion, cache)
// ---------------------------------------------------------------------

async function getCompletions({ config, apiKey, prefix, suffix, numSuggestions, lineMode, token }) {
  const endpoint = config.get('endpoint');
  const model = config.get('model');
  const temperature = config.get('temperature');
  const timeoutMs = config.get('requestTimeoutMs');
  const maxRetries = config.get('maxRetries');
  const cooldownMs = config.get('cooldownMs');
  const { maxTokens, stop } = getModeParams(lineMode, config);

  // seed[0] is the "primary" deterministic request; extras get random
  // seeds so they diverge instead of returning the same text n times.
  const seeds = Array.from({ length: numSuggestions }, (_, i) =>
    i === 0 ? undefined : Math.floor(Math.random() * 1e9)
  );

  const settled = await Promise.all(
    seeds.map(seed =>
      fetchWithRetry({
        endpoint,
        model,
        apiKey,
        prefix,
        suffix,
        maxTokens,
        temperature,
        stop,
        seed,
        token,
        timeoutMs,
        maxRetries,
        cooldownMs
      })
    )
  );

  const successes = settled.filter(r => r && r.text);
  let processed = successes.map(r => trimSuffixOverlap(r.text, suffix));
  if (lineMode === 'multi-line') {
    processed = processed.map(trimTrailingBlankLines);
  }
  const completions = [...new Set(processed.filter(t => t && t.length > 0))];

  return {
    completions,
    usageList: successes.map(r => r.usage).filter(Boolean),
    elapsed: successes.length ? Math.max(...successes.map(r => r.elapsed)) : null
  };
}

async function fetchWithRetry(params) {
  const { token, maxRetries, cooldownMs } = params;
  let attempt = 0;

  while (true) {
    if (token.isCancellationRequested) return null;
    if (Date.now() < cooldownUntil) return null; // still cooling down from a prior 429

    try {
      return await doFetch(params);
    } catch (err) {
      if (err.name === 'AbortError' && token.isCancellationRequested) {
        return null; // user moved on — not a real failure, don't log/retry
      }

      if (err.status === 401) {
        if (!invalidKeyNotified) {
          invalidKeyNotified = true;
          vscode.window.showErrorMessage(
            'LeanComplete: Auth Error (401). Your API key may be invalid for this endpoint. Run "Configure Provider" to fix it.'
          );
        }
        lastError = 'Auth Error (401) - Check Key/Provider';
        updateStatusBar();
        return null;
      }

      if (err.status === 404) {
        lastError = 'Not Found (404) - Endpoint/Model mismatch';
        updateStatusBar();
        return null;
      }

      if (err.status === 429) {
        enterCooldown(err.retryAfterMs || cooldownMs);
        lastError = 'Rate limited (429)';
        return null;
      }

      const timedOut = err.name === 'AbortError' && err.timedOut;
      const isRetryable = timedOut || (err.status && err.status >= 500) || !err.status;

      if (isRetryable && attempt < maxRetries) {
        const backoffMs = 400 * 2 ** attempt + Math.floor(Math.random() * 200);
        await sleepCancelable(backoffMs, token);
        if (token.isCancellationRequested) return null;
        attempt++;
        continue;
      }

      const detail = err && err.body ? `${err.message}\n${err.body}` : (err && err.stack) || String(err);
      logError(`Request failed: ${detail}`);
      lastError = timedOut ? 'Request timed out' : err.message || String(err);
      return null;
    }
  }
}

async function doFetch({ endpoint, model, apiKey, prefix, suffix, maxTokens, temperature, stop, seed, token, timeoutMs }) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const cancelSub = token.onCancellationRequested(() => controller.abort());
  const start = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        prompt: prefix,
        suffix,
        max_tokens: maxTokens,
        temperature,
        random_seed: seed,
        stop
      }),
      signal: controller.signal
    });

    const elapsed = Date.now() - start;

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      err.body = bodyText;
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        err.retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      }
      throw err;
    }

    const data = await response.json();
    return {
      text: data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || null,
      usage: (data && data.usage) || null,
      elapsed
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      const timedOut = !token.isCancellationRequested;
      const e = new Error(timedOut ? 'Request timed out' : 'Request cancelled');
      e.name = 'AbortError';
      e.timedOut = timedOut;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    cancelSub.dispose();
  }
}

function enterCooldown(ms) {
  const newUntil = Date.now() + ms;
  if (newUntil > cooldownUntil) cooldownUntil = newUntil;
  if (!cooldownNotified) {
    cooldownNotified = true;
    vscode.window.setStatusBarMessage(
      `LeanComplete: rate limited, pausing ~${Math.ceil(ms / 1000)}s`,
      Math.min(ms, 8000)
    );
  }
  updateStatusBar();
}

// ---------------------------------------------------------------------
// Post-processing: suffix-overlap trimming, trailing blank line cleanup
// ---------------------------------------------------------------------

function trimSuffixOverlap(completion, suffix) {
  if (!completion || !suffix) return completion;
  const maxCheck = Math.min(completion.length, suffix.length, 200);
  for (let k = maxCheck; k > 0; k--) {
    if (completion.slice(-k) === suffix.slice(0, k)) {
      return completion.slice(0, completion.length - k);
    }
  }
  return completion;
}

// Multi-line completions occasionally trail off with one or more blank
// lines before hitting the stop sequence. Strip them so an accepted
// suggestion doesn't leave dangling empty lines to clean up by hand.
function trimTrailingBlankLines(text) {
  if (!text) return text;
  return text.replace(/(\r?\n[ \t]*)+$/, '');
}

// ---------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------

function buildCacheKey(config, prefix, suffix, numSuggestions, lineMode) {
  return `${config.get('model')}::${lineMode}::${numSuggestions}::${prefix}\u0000${suffix}`;
}

function setCache(key, completions) {
  if (responseCache.has(key)) responseCache.delete(key); // refresh insertion order
  responseCache.set(key, completions);
  if (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
}

// ---------------------------------------------------------------------
// Usage tracking (local only — nothing leaves the machine besides the
// completion requests themselves)
// ---------------------------------------------------------------------

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getUsageStats() {
  const stats = context.globalState.get(USAGE_KEY);
  const today = getTodayKey();
  if (!stats || stats.date !== today) return { date: today, requests: 0, tokens: 0 };
  return stats;
}

function recordUsage(usageList) {
  const stats = getUsageStats();
  for (const u of usageList) {
    stats.requests += 1;
    stats.tokens += (u && u.total_tokens) || 0;
  }
  context.globalState.update(USAGE_KEY, stats);
}

// ---------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------

function updateStatusBar() {
  if (!statusBarItem) return;

  if (!enabled) {
    statusBarItem.text = '$(circle-slash) LeanComplete';
    statusBarItem.tooltip = buildTooltip();
    return;
  }
  if (activeRequestCount > 0) {
    statusBarItem.text = '$(sync~spin) LeanComplete';
    statusBarItem.tooltip = buildTooltip();
    return;
  }
  if (lastError) {
    statusBarItem.text = '$(warning) LeanComplete';
    statusBarItem.tooltip = buildTooltip();
    return;
  }
  statusBarItem.text = '$(symbol-snippet) LeanComplete';
  statusBarItem.tooltip = buildTooltip();
}

function buildTooltip() {
  const config = vscode.workspace.getConfiguration('leanComplete');
  const lines = [`LeanComplete: ${enabled ? 'on' : 'off'} (${config.get('completionMode')})`];
  if (lastLatencyMs != null) lines.push(`Last request: ${lastLatencyMs}ms`);
  const stats = getUsageStats();
  if (stats.requests > 0) lines.push(`Today: ${stats.requests} request(s), ~${stats.tokens} tokens`);
  if (lastError) lines.push(`Last error: ${lastError}`);
  lines.push('Manual Trigger: Alt+\\');
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function logError(message) {
  console.error('LeanComplete:', message);
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sleepCancelable(ms, token) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function deactivate() {
  if (tickHandle) clearInterval(tickHandle);
}

module.exports = { activate, deactivate };
