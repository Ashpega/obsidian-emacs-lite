const { Prec } = require("@codemirror/state");
const { keymap } = require("@codemirror/view");
const { Plugin, MarkdownView, PluginSettingTab, Setting } = require("obsidian");
const { clipboard } = require("electron");
const {
    cursorLineBoundaryForward,
    cursorLineBoundaryBackward,
    cursorLineUp,
    cursorLineDown
} = require("@codemirror/commands");
const {
    cursorGroupForward,
    cursorGroupBackward,
    deleteGroupForward,
    deleteGroupBackward
} = require("@codemirror/commands");
const { EditorSelection } = require("@codemirror/state");

// Default plugin settings
// - enableKeyRepeat: allows press-and-hold repetition for supported Emacs-like keys
// - lineMode: "logical" (default) or "visual" line behavior
// - enableExtendedDelete: toggles extended delete bindings (Ctrl+H / Alt+H)
// - enableExtendedSelection: toggles extended selection binding (Ctrl+;)
// - enableSystemOverride: toggles overriding of common system shortcuts (Ctrl+X/C/Z)
const DEFAULT_SETTINGS = {
    enableKeyRepeat: true,
    lineMode: "logical",
    
    enableExtendedDelete: true,   // Ctrl+H / Alt+H
    enableExtendedSelection: true, // Ctrl+;
    enableSystemOverride: true,   // Ctrl+X/C/Z
};

/*
  Character classification helpers for Japanese-aware "chunk" operations
  used in Alt+F / Alt+B / Alt+D / Alt+H.

  These functions define boundaries between:
  - ASCII words (A-Za-z0-9_)
  - whitespace
  - punctuation (including Japanese punctuation)
  - Japanese scripts (e.g., Hiragana)

  The goal is to provide practical, editor-friendly navigation and deletion
  behavior rather than strict linguistic correctness.
*/

function isAsciiWordChar(ch) {
    return /[A-Za-z0-9_]/.test(ch);
}

function isWhitespace(ch) {
    return /\s/.test(ch);
}

function isPunctuation(ch) {
    return /[、。.,!?;:()\[\]{}「」『』【】〈〉《》〔〕…]/.test(ch);
}

function isHiragana(ch) {
    return /[\u3040-\u309F]/.test(ch);
}

function isKatakana(ch) {
    return /[\u30A0-\u30FF]/.test(ch);
}

function isKanji(ch) {
    return /[\u4E00-\u9FFF]/.test(ch);
}

function getCharCategory(ch) {
    if (!ch) return "other";
    if (isWhitespace(ch)) return "space";
    if (isPunctuation(ch)) return "punct";
    if (isAsciiWordChar(ch)) return "ascii";
    if (isHiragana(ch)) return "hiragana";
    if (isKatakana(ch)) return "katakana";
    if (isKanji(ch)) return "kanji";
    return "other";
}


/*
 * Returns the next editing-chunk boundary for Alt+F.
 *
 * This is a lightweight, Japanese-aware boundary finder for mixed Japanese/ASCII text.
 * It groups ASCII words, Katakana runs, punctuation runs, Kanji runs, and Hiragana runs.
 * After a Kanji run, trailing Hiragana may be partially or fully included depending on context.
 */
function findWordForwardBoundary(line, startCh) {
    const len = line.length;
    let ch = startCh;

    if (ch >= len) return ch;

    // Skip leading whitespace.
    while (ch < len && getCharCategory(line[ch]) === "space") {
	ch++;
    }
    if (ch >= len) return ch;

    // Treat punctuation as one chunk.
    if (getCharCategory(line[ch]) === "punct") {
	while (ch < len && getCharCategory(line[ch]) === "punct") {
	    ch++;
	}
	return ch;
    }

    // Treat ASCII word characters as one chunk.
    if (getCharCategory(line[ch]) === "ascii") {
	while (ch < len && getCharCategory(line[ch]) === "ascii") {
	    ch++;
	}
	return ch;
    }

    // Treat Katakana as one chunk.
    if (getCharCategory(line[ch]) === "katakana") {
	while (ch < len && getCharCategory(line[ch]) === "katakana") {
	    ch++;
	}
	return ch;
    }

    // Consume a Kanji run, then decide how much trailing Hiragana to include.
    if (getCharCategory(line[ch]) === "kanji") {
	while (ch < len && getCharCategory(line[ch]) === "kanji") {
	    ch++;
	}

	const hiraStart = ch;

	while (ch < len && getCharCategory(line[ch]) === "hiragana") {
	    ch++;
	}

	const hiraEnd = ch;
	const hiraLen = hiraEnd - hiraStart;
	const nextCat = ch < len ? getCharCategory(line[ch]) : "eol";

	// If another Kanji run follows, keep only a short Hiragana suffix.
	if (nextCat === "kanji") {
	    return hiraStart + Math.min(hiraLen, 2);
	}

        // Otherwise include the full trailing Hiragana run.
	return hiraEnd;
    }

    // Treat Hiragana as one chunk.
    if (getCharCategory(line[ch]) === "hiragana") {
	while (ch < len && getCharCategory(line[ch]) === "hiragana") {
	    ch++;
	}
	return ch;
    }

    // Fallback: move by one character.
    return ch + 1;
}

/*
 * Returns the previous editing-chunk boundary for Alt+B.
 *
 * This is a lightweight, Japanese-aware boundary finder for mixed Japanese/ASCII text.
 * Short Hiragana suffixes directly following Kanji may be merged back into the Kanji chunk.
 */
function findWordBackwardBoundary(line, startCh) {
    let ch = startCh;

    if (ch <= 0) return 0;

    // Start from the character to the left of the cursor.
    ch--;

    // Skip trailing whitespace.
    while (ch >= 0 && getCharCategory(line[ch]) === "space") {
	ch--;
    }
    if (ch < 0) return 0;

    // Treat punctuation as one chunk.
    if (getCharCategory(line[ch]) === "punct") {
	while (ch >= 0 && getCharCategory(line[ch]) === "punct") {
	    ch--;
	}
	return ch + 1;
    }

    // Treat ASCII word characters as one chunk.
    if (getCharCategory(line[ch]) === "ascii") {
	while (ch >= 0 && getCharCategory(line[ch]) === "ascii") {
	    ch--;
	}
	return ch + 1;
    }

    // Treat ASCII word characters as one chunk.
    if (getCharCategory(line[ch]) === "katakana") {
	while (ch >= 0 && getCharCategory(line[ch]) === "katakana") {
	    ch--;
	}
	return ch + 1;
    }

    // Consume a Hiragana run and optionally merge it into a preceding Kanji run.
    if (getCharCategory(line[ch]) === "hiragana") {
	const hiraEnd = ch + 1;

	while (ch >= 0 && getCharCategory(line[ch]) === "hiragana") {
	    ch--;
	}

	const hiraStart = ch + 1;
	const hiraLen = hiraEnd - hiraStart;
	const prevCat = ch >= 0 ? getCharCategory(line[ch]) : "bol";

        // Merge short Hiragana suffixes into the preceding Kanji chunk.
	if (prevCat === "kanji" && hiraLen <= 2) {
	    while (ch >= 0 && getCharCategory(line[ch]) === "kanji") {
		ch--;
	    }
	    return ch + 1;
	}

	return hiraStart;
    }

    // Treat Kanji as one chunk.
    if (getCharCategory(line[ch]) === "kanji") {
	while (ch >= 0 && getCharCategory(line[ch]) === "kanji") {
	    ch--;
	}
	return ch + 1;
    }

    // Fallback: move back by one character.
    return ch;
}


module.exports = class EmacsLitePlugin extends Plugin {

    async loadSettings() {
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
	await this.saveData(this.settings);
    }
    
    async onload() {

	this.markActive = false;
	this.markAnchor = null;

	await this.loadSettings();
	this.addSettingTab(new EmacsLiteSettingTab(this.app, this));

	const repeatHandler = (event) => {
	    const key = event.key.toLowerCase();

	    const isCtrlTarget =
		  event.ctrlKey &&
		  !event.altKey &&
		!event.shiftKey &&
		!event.metaKey &&
		["f", "b", "p", "n", "k", "d", "h"].includes(key);

	    const isAltTarget =
		  event.altKey &&
		  !event.ctrlKey &&
		!event.shiftKey &&
		!event.metaKey &&
		["f", "b", "d", "h"].includes(key);

	    if (!(isCtrlTarget || isAltTarget)) return;
	    if (!event.repeat) return;

	    if (!this.settings.enableKeyRepeat) {
		event.preventDefault();
		event.stopPropagation();
		if (typeof event.stopImmediatePropagation === "function") {
		    event.stopImmediatePropagation();
		}
	    }
	};

	window.addEventListener("keydown", repeatHandler, true);
	this.register(() => window.removeEventListener("keydown", repeatHandler, true));
	
	// Ctrl+M: insert a newline
	this.addCommand({
	    id: "insert-newline",
	    name: "Insert newline",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "m" }],
	    editorCallback: (editor) => {
		editor.replaceSelection("\n");

		if (this.markActive) {
		    this.clearMark(editor);
		}
	    },
	});

	// Ctrl+A: move to line start
	this.addCommand({
	    id: "cursor-line-start",
	    name: "Move to line start",
	    editorCallback: (editor) => this.cursorLineStart(editor),
	});

	// Ctrl+E: move to line end
	this.addCommand({
	    id: "cursor-line-end",
	    name: "Move to line end",
	    editorCallback: (editor) => this.cursorLineEnd(editor),
	});

	// Ctrl+F: move forward by one character
	this.addCommand({
	    id: "cursor-forward",
	    name: "Move cursor forward by character",
	    editorCallback: (editor) => this.moveCharForward(editor),
	});
	
	// Ctrl+B: move backward by one character
	this.addCommand({
	    id: "cursor-backward",
	    name: "Move cursor backward by character",
	    editorCallback: (editor) => this.moveCharBackward(editor),
	});

	// Ctrl+N: move down by one visual line
	this.addCommand({
	    id: "move-visual-line-down",
	    name: "Move visual line down",
	    editorCallback: (editor) => this.moveLineDown(editor),
	});

	// Ctrl+P: move up by one visual line
	this.addCommand({
	    id: "move-visual-line-up",
	    name: "Move visual line up",
	    editorCallback: (editor) => this.moveLineUp(editor),
	});
	
	// Ctrl+D: delete the character after the cursor
	this.addCommand({
            id: "delete-char-forward",
            name: "Delete character forward",
            editorCallback: (editor) => this.deleteCharForward(editor),
        });

	// Ctrl+H: delete the character before the cursor
	this.addCommand({
	    id: "delete-char-backward",
	    name: "Delete character backward",
	    editorCallback: (editor) => this.deleteCharBackward(editor),
	});

	// Alt+F: move forward by one chunk
	this.addCommand({
	    id: "cursor-chunk-forward",
	    name: "Move cursor forward by chunk",
	    editorCallback: (editor) => this.moveChunkForward(editor),
	});

	// Alt+B: move backward by one chunk
	this.addCommand({
	    id: "cursor-chunk-backward",
	    name: "Move cursor backward by chunk",
	    editorCallback: (editor) => this.moveChunkBackward(editor),
	});

	// Alt+D: delete one chunk forward
	this.addCommand({
	    id: "delete-chunk-forward",
	    name: "Delete chunk forward",
	    editorCallback: (editor) => this.deleteChunkForward(editor),
	});

	// Alt+H: delete one chunk backward
	this.addCommand({
	    id: "delete-chunk-backward",
	    name: "Delete chunk backward",
	    editorCallback: (editor) => this.deleteChunkBackward(editor),
	});

	// Ctrl+K: kill from the cursor to the end of the line
	this.addCommand({
	    id: "kill-to-end-of-line",
	    name: "Kill to end of line",
	    editorCallback: (editor) => this.killToEndOfLine(editor),
	});

	// Ctrl+;: select from the cursor to the end of the line
	this.addCommand({
	    id: "select-to-end-of-line",
	    name: "Select to end of line",
	    editorCallback: (editor) => this.selectToEndOfLine(editor),
	});

	// Ctrl+W: kill the current selection
	this.addCommand({
	    id: "kill-region",
	    name: "Kill region",
	    editorCallback: (editor) => this.killRegion(editor),
	});
	
	// Alt+W: copy the current selection without deleting it
	this.addCommand({
	    id: "copy-region",
	    name: "Copy region",
	    editorCallback: (editor) => this.copyRegion(editor),
	});


	// Ctrl+Y: yank from the system clipboard
	this.addCommand({
	    id: "yank",
	    name: "Yank",
	    editorCallback: async (editor) => this.yank(editor),
	});	

	// Ctrl+C: copy the selection and clear mark
	this.addCommand({
	    id: "copy-region-ctrl-c",
	    name: "Copy region (Ctrl+C)",
	    editorCallback: (editor) => this.copyRegionCtrlC(editor),
	});

	// Ctrl+L: recenter the cursor in the editor view
	this.addCommand({
	    id: "recenter-cursor",
	    name: "Recenter cursor",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "l" }],
	    editorCallback: (editor) => {
		const cursor = editor.getCursor();

		// Scroll the cursor into view first.
		editor.scrollIntoView(
		    { from: cursor, to: cursor },
		    true
		);

		// Then adjust the scroll position to place it near the vertical center.
		requestAnimationFrame(() => {
		    const wrapper = document.querySelector(".cm-scroller");
		    const cursorEl = document.querySelector(".cm-cursor");

		    if (!wrapper || !cursorEl) {
			return;
		    }

		    const wrapperRect = wrapper.getBoundingClientRect();
		    const cursorRect = cursorEl.getBoundingClientRect();

		    const currentScrollTop = wrapper.scrollTop;
		    const offset =
			  (cursorRect.top - wrapperRect.top) - wrapperRect.height / 2;

		    wrapper.scrollTop = currentScrollTop + offset;
		});
	    },
	});

	// Ctrl+X: cut only when a selection exists
	this.addCommand({
	    id: "cut-region-ctrl-x",
	    name: "Cut region (Ctrl+X)",
	    editorCallback: (editor) => this.cutRegionCtrlX(editor),
	});
	
	// Ctrl+<: move to the start of the document
	this.addCommand({
	    id: "go-to-document-start",
	    name: "Go to document start",
	    hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "," }],
	    editorCallback: (editor) => {
		editor.setCursor({ line: 0, ch: 0 });
	    },
	});

	
	// Ctrl+>: move to the end of the document
	this.addCommand({
	    id: "go-to-document-end",
	    name: "Go to document end",
	    hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "." }],
	    editorCallback: (editor) => {
		const lastLine = editor.lineCount() - 1;
		const lastCh = editor.getLine(lastLine).length;
		editor.setCursor({ line: lastLine, ch: lastCh });
	    },
	});

	// Ctrl+Space: set mark at the current cursor position
	this.addCommand({
	    id: "set-mark",
	    name: "Set mark",
	    hotkeys: [{ modifiers: ["Ctrl"], key: " " }],
	    editorCallback: (editor) => {
		const cursor = editor.getCursor();
		this.markActive = true;
		this.markAnchor = { line: cursor.line, ch: cursor.ch };
		editor.setSelection(this.markAnchor, this.markAnchor);
	    },
	});

	// Ctrl+G: clear mark
	this.addCommand({
	    id: "cancel-mark",
	    name: "Cancel mark",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "g" }],
	    editorCallback: (editor) => {
		if (!this.markActive) return;
		this.clearMark(editor);
	    },
	});

	// Keep the selection in sync while mark is active.
	this.registerDomEvent(document, "keyup", (evt) => {
	    if (!this.markActive) return;

            // Ignore the keys used to set or clear mark themselves.
	    if (evt.ctrlKey && (evt.key === "g" || evt.code === "Space")) {
		return;
	    }

	    const editor = this.getActiveEditor();
	    if (!editor) return;

	    this.syncMarkSelection(editor);
	});

	// Keymap layer:
	// - binds supported Emacs-style shortcuts at high priority
	// - dispatches all actions through command IDs for consistency
	// - returns false for toggleable overrides to fall back to native behavior	
	this.registerEditorExtension(
	    Prec.high(
		keymap.of([
		    {
			key: "Ctrl-a",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-line-start");
			    return true;
			},
		    },
		    {
			key: "Ctrl-e",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-line-end");
			    return true;
			},
		    },
		    {
			key: "Ctrl-f",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-forward");
			    return true;
			}
		    },
		    {
			key: "Ctrl-b",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-backward");
			    return true;
			},
		    },
		    {
			key: "Ctrl-p",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:move-visual-line-up");
			    return true;
			},
		    },
		    {
			key: "Ctrl-n",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:move-visual-line-down");
			    return true;
			},
		    },
		    {
			key: "Ctrl-d",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:delete-char-forward");
			    return true;
			},
		    },
		    {
			key: "Ctrl-h",
			run: () => {
			    if (!this.settings.enableExtendedDelete) return false;

			    this.app.commands.executeCommandById("obsidian-emacs-lite:delete-char-backward");
			    return true;
			},
		    },
		    {
			key: "Alt-f",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-chunk-forward");
			    return true;
			},
		    },
		    {
			key: "Alt-b",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:cursor-chunk-backward");
			    return true;
			},
		    },
		    {
			key: "Alt-d",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:delete-chunk-forward");
			    return true;
			},
		    },
		    {
			key: "Alt-h",
			run: () => {
			    if (!this.settings.enableExtendedDelete) return false;

			    this.app.commands.executeCommandById("obsidian-emacs-lite:delete-chunk-backward");
			    return true;
			},
		    },
		    {
			key: "Alt-w",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:copy-region");
			    return true;
			}
		    },
		    {
			key: "Ctrl-w",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:kill-region");
			    return true;
			}
		    },
		    {
			key: "Ctrl-c",
			run: () => {
			    if (!this.settings.enableSystemOverride) return false;

			    this.app.commands.executeCommandById("obsidian-emacs-lite:copy-region-ctrl-c");
			    return true;
			},
		    },
		    {
			key: "Ctrl-x",
			run: () => {
			    if (!this.settings.enableSystemOverride) return false;

			    this.app.commands.executeCommandById("obsidian-emacs-lite:cut-region-ctrl-x");
			    return true;
			},
		    },
		    {
			key: "Ctrl-k",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:kill-to-end-of-line");
			    return true;
			}
		    },
		    {
			key: "Ctrl-;",
			preventDefault: true,
			run: () => {
			    if (!this.settings.enableExtendedSelection) return false;

			    this.app.commands.executeCommandById("obsidian-emacs-lite:select-to-end-of-line");
			    return true;
			},
		    },
		    {
			key: "Ctrl-y",
			preventDefault: true,
			run: () => {
			    this.app.commands.executeCommandById("obsidian-emacs-lite:yank");
			    return true;
			}
		    },
		])
	    )
	);
    }


    /*
     * Command implementation layer.
     *
     * - Each method corresponds to a command invoked from the keymap layer.
     * - Behavior is split between logical / visual line modes where applicable.
     * - Mark state (selection) is consistently updated after cursor movement.
     * - CodeMirror APIs are used when available, with fallback to editor methods.
     */
    
    // Return visual line end position without moving the cursor.
    getVisualLineEnd(editor) {
	const cm = this.getEditorView();

	if (cm) {
            const before = editor.getCursor();
            cursorLineBoundaryForward(cm);
            const after = editor.getCursor();
            editor.setCursor(before);
            return after;
	}

	// fallback: logical line end
	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);
	return { line: cursor.line, ch: lineText.length };
    }

    // Get the active editor instance.
    getActiveEditor() {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	return view ? view.editor : null;
    }

    // Update selection when mark is active.
    syncMarkSelection(editor) {
	if (!this.markActive || !this.markAnchor) return;

	const cursor = editor.getCursor();

	editor.setSelection(
            { line: this.markAnchor.line, ch: this.markAnchor.ch },
            { line: cursor.line, ch: cursor.ch }
	);
    }

    // Clear mark state and collapse selection.
    clearMark(editor) {
	const cursor = editor.getCursor("to");
	editor.setCursor(cursor);
	this.markActive = false;
	this.markAnchor = null;
    }

    
    // Get underlying CodeMirror EditorView (if available).
    getEditorView() {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return null;

	// Obsidian内部のCM6 EditorView
	return view.editor?.cm ?? null;
    }

    // Ctrl+A: move to line start (logical / visual)
    cursorLineStart(editor) {
	if (this.settings.lineMode === "logical") {
            return this.cursorLogicalLineStart(editor);
	}

	return this.cursorVisualLineStart(editor);
    }

    // Visual line start (CodeMirror boundary)
    cursorVisualLineStart(editor) {
	const cm = this.getEditorView();

	if (cm) {
            cursorLineBoundaryBackward(cm);
	} else {
            const cursor = editor.getCursor();
            editor.setCursor({ line: cursor.line, ch: 0 });
	}

	if (this.markActive) {
            this.syncMarkSelection(editor);
	}

	return true;
    }

    // Logical line start (column 0)
    cursorLogicalLineStart(editor) {
	const cursor = editor.getCursor();
	editor.setCursor({ line: cursor.line, ch: 0 });

	if (this.markActive) {
            this.syncMarkSelection(editor);
	}

	return true;
    }
    
    // Ctrl+E: move to line end (logical / visual)
    cursorLineEnd(editor) {
	if (this.settings.lineMode === "logical") {
            return this.cursorLogicalLineEnd(editor);
	}

	return this.cursorVisualLineEnd(editor);
    }

    // Visual line end (CodeMirror boundary)
    cursorVisualLineEnd(editor) {
	const cm = this.getEditorView();

	if (cm) {
            cursorLineBoundaryForward(cm);
	} else {
            const cursor = editor.getCursor();
            const lineText = editor.getLine(cursor.line);
            editor.setCursor({ line: cursor.line, ch: lineText.length });
	}

	if (this.markActive) {
            this.syncMarkSelection(editor);
	}

	return true;
    }

    // Logical line end (line length)
    cursorLogicalLineEnd(editor) {
	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);

	editor.setCursor({ line: cursor.line, ch: lineText.length });

	if (this.markActive) {
            this.syncMarkSelection(editor);
	}

	return true;
    }

    
    // Alt+W: Copy selection without deleting it 
    copyRegion(editor) {
	const selection = editor.getSelection();

	if (!selection || selection.length === 0) {
	    return true;
	}

	clipboard.writeText(selection);
	// this.lastYankText = selection;

	if (this.markActive) {
	    this.clearMark(editor);
	}

	return true;
    }
    
    // Ctrl+W: Kill (cut) selection
    killRegion(editor) {
	const selection = editor.getSelection();

	if (!selection || selection.length === 0) {
	    return true;
	}

	clipboard.writeText(selection);
	// this.lastYankText = selection;

	editor.replaceSelection("");

	if (this.markActive) {
	    this.clearMark(editor);
	}

	return true;
    }
    
    // Ctrl+C: Copy selection and clear mark
    copyRegionCtrlC(editor) {
	const selection = editor.getSelection();

	if (!selection || selection.length === 0) {
	    return true;
	}

	clipboard.writeText(selection);

	if (this.markActive) {
	    this.clearMark(editor);
	}

	return true;
    }

    // Ctrl+X: Cut selection only if it exists
    cutRegionCtrlX(editor) {
	const selection = editor.getSelection();

	if (!selection || selection.length === 0) {
	    return true;
	}

	clipboard.writeText(selection);

	editor.replaceSelection("");

	if (this.markActive) {
	    this.clearMark(editor);
	}

	return true;
    }

    // Ctrl+F: Move forward by one character
    moveCharForward(editor) {
	const offset = editor.posToOffset(editor.getCursor());
	const newPos = editor.offsetToPos(offset + 1);

	editor.setCursor(newPos);

	if (this.markActive) {
	    this.syncMarkSelection(editor);
	}
	return true;
    }

    // Ctrl+B: Move forward by one character
    moveCharBackward(editor) {
	const offset = editor.posToOffset(editor.getCursor());
	const newOffset = Math.max(offset - 1, 0);
	const newPos = editor.offsetToPos(newOffset);

	editor.setCursor(newPos);

	if (this.markActive) {
	    this.syncMarkSelection(editor);
	}

	return true;
    }

    // Ctrl+P: Move backward by one character
    // Keeps selection consistent when mark is active.
    moveLineUp(editor) {
	const cm = this.getEditorView();

	if (cm) {
	    if (this.markActive && this.markAnchor) {
		const head = cm.state.selection.main.head;

		cm.dispatch({
		    selection: { anchor: head, head: head }
		});

		cursorLineUp(cm);

		const newHead = cm.state.selection.main.head;
		const newPos = cm.state.doc.lineAt(newHead);

		editor.setSelection(
		    { line: this.markAnchor.line, ch: this.markAnchor.ch },
		    { line: newPos.number - 1, ch: newHead - newPos.from }
		);
	    } else {
		cursorLineUp(cm);
	    }
	} else {
	    const cursor = editor.getCursor();
	    const newLine = Math.max(cursor.line - 1, 0);
	    const lineLength = editor.getLine(newLine).length;
	    const newCh = Math.min(cursor.ch, lineLength);

	    if (this.markActive && this.markAnchor) {
		editor.setSelection(
		    { line: this.markAnchor.line, ch: this.markAnchor.ch },
		    { line: newLine, ch: newCh }
		);
	    } else {
		editor.setCursor({ line: newLine, ch: newCh });
	    }
	}

	return true;
    }

    // Ctrl+N: Move down by one visual line
    // Keeps selection consistent when mark is active.
    moveLineDown(editor) {
	const cm = this.getEditorView();

	if (cm) {
	    if (this.markActive && this.markAnchor) {
		const head = cm.state.selection.main.head;

		cm.dispatch({
		    selection: { anchor: head, head: head }
		});

		cursorLineDown(cm);

		const newHead = cm.state.selection.main.head;
		const newPos = cm.state.doc.lineAt(newHead);

		editor.setSelection(
		    { line: this.markAnchor.line, ch: this.markAnchor.ch },
		    { line: newPos.number - 1, ch: newHead - newPos.from }
		);
	    } else {
		cursorLineDown(cm);
	    }
	} else {
	    const cursor = editor.getCursor();
	    const newLine = Math.min(cursor.line + 1, editor.lineCount() - 1);
	    const lineLength = editor.getLine(newLine).length;
	    const newCh = Math.min(cursor.ch, lineLength);

	    if (this.markActive && this.markAnchor) {
		editor.setSelection(
		    { line: this.markAnchor.line, ch: this.markAnchor.ch },
		    { line: newLine, ch: newCh }
		);
	    } else {
		editor.setCursor({ line: newLine, ch: newCh });
	    }
	}

	return true;
    }
    

    // Ctrl+D: Delete character forward
    // Joins lines when at end of line.
    deleteCharForward(editor) {
	const selection = editor.getSelection();

	if (selection && selection.length > 0) {
            editor.replaceSelection("");

            if (this.markActive) {
		this.clearMark(editor);
            }

            return true;
	}

	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);

	const isEndOfLine = cursor.ch >= line.length;
	const isLastLine = cursor.line >= editor.lineCount() - 1;

	if (isEndOfLine && isLastLine) {
            return true;
	}

	const from = { line: cursor.line, ch: cursor.ch };
	const to = isEndOfLine
              ? { line: cursor.line + 1, ch: 0 }
              : { line: cursor.line, ch: cursor.ch + 1 };

	editor.replaceRange("", from, to);

	return true;
    }
    
    // Ctrl+H: Delete character backward
    // Joins lines when at start of line.
    deleteCharBackward(editor) {
	const selection = editor.getSelection();

	if (selection && selection.length > 0) {
	    editor.replaceSelection("");

	    if (this.markActive) {
		this.clearMark(editor);
	    }

	    return true;
	}

	const cursor = editor.getCursor();

	const isStartOfLine = cursor.ch === 0;
	const isFirstLine = cursor.line === 0;

	if (isStartOfLine && isFirstLine) {
	    return true;
	}

	const from = isStartOfLine
	      ? { line: cursor.line - 1, ch: editor.getLine(cursor.line - 1).length }
	      : { line: cursor.line, ch: cursor.ch - 1 };

	const to = { line: cursor.line, ch: cursor.ch };

	editor.replaceRange("", from, to);

	return true;
    }

    // Ctrl+K: kill to end of line (logical / visual)
    killToEndOfLine(editor) {
	if (this.settings.lineMode === "logical") {
            return this.killToEndOfLogicalLine(editor);
	}

	return this.killToEndOfVisualLine(editor);
    }


    /*
     * Range and chunk operations.
     *
     * - Provides range calculation for logical / visual line behavior.
     * - Used by kill (Ctrl+K) and selection (Ctrl+;) commands.
     * - Chunk operations implement Japanese-aware navigation and deletion.
     */

    // Get range to end of logical line.
    getRangeToEndOfLogicalLine(editor) {
	const selection = editor.getSelection();

	if (selection && selection.length > 0) {
            const from = editor.getCursor("from");
            const to = editor.getCursor("to");
            return { from, to, text: selection };
	}

	const from = editor.getCursor();
	const lineText = editor.getLine(from.line);
	const logicalEnd = { line: from.line, ch: lineText.length };

	const atLogicalEnd = from.line === logicalEnd.line && from.ch === logicalEnd.ch;
	const isLastLine = from.line >= editor.lineCount() - 1;

	if (atLogicalEnd) {
            if (!isLastLine) {
		const to = { line: from.line + 1, ch: 0 };
		const text = editor.getRange(from, to);
		return { from, to, text };
            }

            return { from, to: from, text: "" };
	}

	const to = logicalEnd;
	const text = editor.getRange(from, to);
	return { from, to, text };
    }
    
    // Get range to end of visual line.
    getRangeToEndOfVisualLine(editor) {
	const selection = editor.getSelection();

	if (selection && selection.length > 0) {
	    const from = editor.getCursor("from");
	    const to = editor.getCursor("to");
	    return { from, to, text: selection };
	}

	const from = editor.getCursor();
	const visualEnd = this.getVisualLineEnd(editor);

	const atVisualEnd =
	      from.line === visualEnd.line && from.ch === visualEnd.ch;

	const lineText = editor.getLine(from.line);
	const atLogicalEnd = from.ch >= lineText.length;
	const isLastLine = from.line >= editor.lineCount() - 1;

	if (atVisualEnd) {
	    if (atLogicalEnd && !isLastLine) {
		const to = { line: from.line + 1, ch: 0 };
		const text = editor.getRange(from, to);
		return { from, to, text };
	    }

	    return { from, to: from, text: "" };
	}

	const to = visualEnd;
	const text = editor.getRange(from, to);
	return { from, to, text };
    }

    // Apply kill operation: copy to clipboard and delete.
    applyKillRange(editor, rangeInfo) {
	const { from, to, text } = rangeInfo;

	if (!text || text.length === 0) return true;

	clipboard.writeText(text);

	editor.replaceRange("", from, to);
	editor.setCursor(from);

	return true;
    }

    // Kill to end of logical line.
    killToEndOfLogicalLine(editor) {
	const rangeInfo = this.getRangeToEndOfLogicalLine(editor);
	return this.applyKillRange(editor, rangeInfo);
    }

    // Kill to end of visual line.
    killToEndOfVisualLine(editor) {
	const rangeInfo = this.getRangeToEndOfVisualLine(editor);
	return this.applyKillRange(editor, rangeInfo);
    }

    // Ctrl+;: select to end of line (logical / visual)
    selectToEndOfLine(editor) {
	if (this.settings.lineMode === "logical") {
            return this.selectToEndOfLogicalLine(editor);
	}

	return this.selectToEndOfVisualLine(editor);
    }

    // Logical line selection (extends mark if active).
    selectToEndOfLogicalLine(editor) {
	if (this.markActive) {
            const cursor = editor.getCursor();
            const lineText = editor.getLine(cursor.line);
            const to = { line: cursor.line, ch: lineText.length };

            editor.setCursor(to);
            this.syncMarkSelection(editor);
            return true;
	}

	const rangeInfo = this.getRangeToEndOfLogicalLine(editor);
	const { from, to, text } = rangeInfo;

	if (!text || text.length === 0) return true;

	editor.setSelection(from, to);
	return true;
    }

    // Visual line selection (extends mark if active).
    selectToEndOfVisualLine(editor) {
	if (this.markActive) {
            const to = this.getVisualLineEnd(editor);
            editor.setCursor(to);
            this.syncMarkSelection(editor);
            return true;
	}

	const rangeInfo = this.getRangeToEndOfVisualLine(editor);
	const { from, to, text } = rangeInfo;

	if (!text || text.length === 0) return true;

	editor.setSelection(from, to);
	return true;
    }
    

    // Ctrl+Y: Paste from system clipboard
    async yank(editor) {
	let text = "";

	try {
	    text = await navigator.clipboard.readText();
	} catch (e) {
	    return true;
	}

	if (!text) {
	    return true;
	}

	editor.replaceSelection(text);

	if (this.markActive) {
	    this.clearMark(editor);
	}

	return true;
    }
    
    // Alt+F: Paste from system clipboard
    moveChunkForward(editor) {
	const cursor = editor.getCursor();

	function moveForwardOne(pos) {
	    const lineText = editor.getLine(pos.line);

	    if (pos.ch < lineText.length) {
		return { line: pos.line, ch: pos.ch + 1 };
	    }

	    if (pos.line < editor.lineCount() - 1) {
		return { line: pos.line + 1, ch: 0 };
	    }

	    return pos;
	}

	let pos = { line: cursor.line, ch: cursor.ch };

	for (let i = 0; i < 1000; i++) {
	    const lineText = editor.getLine(pos.line);
	    const newCh = findWordForwardBoundary(lineText, pos.ch);

	    if (newCh > pos.ch) {
		const newPos = { line: pos.line, ch: newCh };

		if (this.markActive && this.markAnchor) {
		    editor.setSelection(
			{ line: this.markAnchor.line, ch: this.markAnchor.ch },
			newPos
		    );
		} else {
		    editor.setCursor(newPos);
		}
		return true;
	    }

	    const nextPos = moveForwardOne(pos);

	    if (nextPos.line === pos.line && nextPos.ch === pos.ch) {
		if (this.markActive && this.markAnchor) {
		    editor.setSelection(
			{ line: this.markAnchor.line, ch: this.markAnchor.ch },
			pos
		    );
		} else {
		    editor.setCursor(pos);
		}
		return true;
	    }

	    pos = nextPos;
	}

	return true;
    }

    // Alt+B: Move forward by one chunk
    moveChunkBackward(editor) {
	const cursor = editor.getCursor();

	function moveBackwardOne(pos) {
	    if (pos.ch > 0) {
		return { line: pos.line, ch: pos.ch - 1 };
	    }

	    if (pos.line > 0) {
		const prevLine = pos.line - 1;
		return { line: prevLine, ch: editor.getLine(prevLine).length };
	    }

	    return pos;
	}

	let pos = { line: cursor.line, ch: cursor.ch };

	for (let i = 0; i < 1000; i++) {
	    const lineText = editor.getLine(pos.line);
	    const newCh = findWordBackwardBoundary(lineText, pos.ch);

	    if (newCh < pos.ch) {
		const newPos = { line: pos.line, ch: newCh };

		if (this.markActive && this.markAnchor) {
		    editor.setSelection(
			{ line: this.markAnchor.line, ch: this.markAnchor.ch },
			newPos
		    );
		} else {
		    editor.setCursor(newPos);
		}
		return true;
	    }

	    const prevPos = moveBackwardOne(pos);

	    if (prevPos.line === pos.line && prevPos.ch === pos.ch) {
		if (this.markActive && this.markAnchor) {
		    editor.setSelection(
			{ line: this.markAnchor.line, ch: this.markAnchor.ch },
			pos
		    );
		} else {
		    editor.setCursor(pos);
		}
		return true;
	    }

	    pos = prevPos;
	}

	return true;
    }

    // Alt+D: Move backward by one chunk
    deleteChunkForward(editor) {
	const selection = editor.getSelection();

	if (selection && selection.length > 0) {
	    editor.replaceSelection("");

	    if (this.markActive) {
		this.clearMark(editor);
	    }

	    return true;
	}

	const cursor = editor.getCursor();
	const from = { line: cursor.line, ch: cursor.ch };

	function moveForwardOne(pos) {
	    const lineText = editor.getLine(pos.line);

	    if (pos.ch < lineText.length) {
		return { line: pos.line, ch: pos.ch + 1 };
	    }

	    if (pos.line < editor.lineCount() - 1) {
		return { line: pos.line + 1, ch: 0 };
	    }

	    return pos;
	}

	let pos = { line: cursor.line, ch: cursor.ch };
	let to = pos;

	for (let i = 0; i < 1000; i++) {
	    const lineText = editor.getLine(pos.line);
	    const newCh = findWordForwardBoundary(lineText, pos.ch);

	    if (newCh > pos.ch) {
		to = { line: pos.line, ch: newCh };
		break;
	    }

	    const nextPos = moveForwardOne(pos);

	    if (nextPos.line === pos.line && nextPos.ch === pos.ch) {
		to = pos;
		break;
	    }

	    pos = nextPos;
	}

	if (to.line === from.line && to.ch === from.ch) {
	    return true;
	}

	editor.replaceRange("", from, to);
	editor.setCursor(from);

	return true;
    }
    

    // Alt+H: Delete backward by one chunk
    deleteChunkBackward(editor) {
	const selection = editor.getSelection();

	// 選択範囲がある場合は、その範囲を削除
	if (selection && selection.length > 0) {
	    editor.replaceSelection("");

	    if (this.markActive) {
		this.clearMark(editor);
	    }

	    return true;
	}

	const cursor = editor.getCursor();
	const to = { line: cursor.line, ch: cursor.ch };

	function moveBackwardOne(pos) {
	    if (pos.ch > 0) {
		return { line: pos.line, ch: pos.ch - 1 };
	    }

	    if (pos.line > 0) {
		const prevLine = pos.line - 1;
		return { line: prevLine, ch: editor.getLine(prevLine).length };
	    }

	    return pos;
	}

	let pos = { line: cursor.line, ch: cursor.ch };
	let from = pos;

	for (let i = 0; i < 1000; i++) {
	    const lineText = editor.getLine(pos.line);
	    const newCh = findWordBackwardBoundary(lineText, pos.ch);

	    if (newCh < pos.ch) {
		from = { line: pos.line, ch: newCh };
		break;
	    }

	    const prevPos = moveBackwardOne(pos);

	    if (prevPos.line === pos.line && prevPos.ch === pos.ch) {
		from = pos;
		break;
	    }

	    pos = prevPos;
	}

	if (from.line === to.line && from.ch === to.ch) {
	    return true;
	}

	editor.replaceRange("", from, to);
	editor.setCursor(from);

	return true;
    }

};


/*
 * Plugin settings UI.
 *
 * Provides runtime toggles for:
 * - key repeat
 * - line mode (visual / logical)
 * - extended key bindings
 * - system shortcut overrides
 */
class EmacsLiteSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
	super(app, plugin);
	this.plugin = plugin;
    }

    display() {
	const { containerEl } = this;
	containerEl.empty();
	
	new Setting(containerEl)
            .setName("Enable key repeat")
            .setDesc("Allow press-and-hold repeat for supported Ctrl/Alt keys.")
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.enableKeyRepeat)
                    .onChange(async (value) => {
                        this.plugin.settings.enableKeyRepeat = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Line mode")
            .setDesc("Choose whether line-based commands use visual lines or logical lines.")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("visual", "Visual line")
                    .addOption("logical", "Logical line")
                    .setValue(this.plugin.settings.lineMode)
                    .onChange(async (value) => {
                        this.plugin.settings.lineMode = value;
                        await this.plugin.saveSettings();
                    })
            );

	new Setting(containerEl)
	    .setName("Extended delete keys")
	    .setDesc("Enable Ctrl+H / Alt+H backward delete")
	    .addToggle(toggle =>
		toggle
		    .setValue(this.plugin.settings.enableExtendedDelete)
		    .onChange(async (value) => {
			this.plugin.settings.enableExtendedDelete = value;
			await this.plugin.saveSettings();
		    })
	    );

	new Setting(containerEl)
	    .setName("Extended selection key")
	    .setDesc("Enable Ctrl+; selection to end of line")
	    .addToggle(toggle =>
		toggle
		    .setValue(this.plugin.settings.enableExtendedSelection)
		    .onChange(async (value) => {
			this.plugin.settings.enableExtendedSelection = value;
			await this.plugin.saveSettings();
		    })
	    );

	new Setting(containerEl)
	    .setName("Override system shortcuts")
	    .setDesc("Override Ctrl+X / Ctrl+C")
	    .addToggle(toggle =>
		toggle
		    .setValue(this.plugin.settings.enableSystemOverride)
		    .onChange(async (value) => {
			this.plugin.settings.enableSystemOverride = value;
			await this.plugin.saveSettings();
		    })
	    );
	
    }
}
