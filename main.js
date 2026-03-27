const { Prec } = require("@codemirror/state");
const { keymap } = require("@codemirror/view");
const { Plugin, MarkdownView } = require("obsidian");
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


/*
  日本語文章に対するAlt+F/B/D/H で必要となるediting chunk関連の関数群
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
 * Alt+F (forward word movement) 用の境界判定関数。
 *
 * 日本語と英語が混在するテキストに対して、
 * 「編集しやすい文節的なまとまり（editing chunk）」の終端を右方向に探索する。
 *
 * 挙動の基本方針：
 * - 英数字列は1語としてまとめて進む
 * - カタカナ列も1語として扱う
 * - 句読点・記号はひとまとまりでスキップ
 * - 漢字列はひとまとまりで進み、
 *   直後のひらがながある場合は文脈に応じて取り込む
 *   - 次に漢字が続く場合：ひらがなは最大1〜2文字まで含める
 *     （例: 「近隣の」「環境は」）
 *   - 句読点・行末・英数字に向かう場合：ひらがな列をすべて含める
 *     （例: 「要素となります」）
 * - ひらがな列単体は1まとまりとして扱う
 *
 * 目的：
 * - Ctrl+F（1文字単位）との差を維持しつつ、
 *   日本語でも自然なジャンプ単位で移動できるようにする
 * - 厳密な形態素解析ではなく、軽量で実用的な区切りを提供する
 */
function findWordForwardBoundary(line, startCh) {
    const len = line.length;
    let ch = startCh;

    if (ch >= len) return ch;

    // 1. 空白を飛ばす
    while (ch < len && getCharCategory(line[ch]) === "space") {
	ch++;
    }
    if (ch >= len) return ch;

    // 2. 句読点はひとまとまりで飛ばす
    if (getCharCategory(line[ch]) === "punct") {
	while (ch < len && getCharCategory(line[ch]) === "punct") {
	    ch++;
	}
	return ch;
    }

    // 3. 英数字列はひとまとまり
    if (getCharCategory(line[ch]) === "ascii") {
	while (ch < len && getCharCategory(line[ch]) === "ascii") {
	    ch++;
	}
	return ch;
    }

    // 4. カタカナ列はひとまとまり
    if (getCharCategory(line[ch]) === "katakana") {
	while (ch < len && getCharCategory(line[ch]) === "katakana") {
	    ch++;
	}
	return ch;
    }

    // 5. 漢字列 + 後続ひらがなの扱いを改善
    if (getCharCategory(line[ch]) === "kanji") {
	// 漢字列本体
	while (ch < len && getCharCategory(line[ch]) === "kanji") {
	    ch++;
	}

	const hiraStart = ch;

	// 直後のひらがな列を全部見る
	while (ch < len && getCharCategory(line[ch]) === "hiragana") {
	    ch++;
	}

	const hiraEnd = ch;
	const hiraLen = hiraEnd - hiraStart;
	const nextCat = ch < len ? getCharCategory(line[ch]) : "eol";

	// 直後に別の漢字が来るなら、ひらがなは短く切る
	// 例: 近隣の環境 -> "近隣の"
	if (nextCat === "kanji") {
	    return hiraStart + Math.min(hiraLen, 2);
	}

	// 句読点・空白・行末・英数字などに向かうなら、ひらがな列を最後まで含める
	// 例: 要素となります。 -> "要素となります"
	return hiraEnd;
    }

    // 6. ひらがな列はひとまとまり
    if (getCharCategory(line[ch]) === "hiragana") {
	while (ch < len && getCharCategory(line[ch]) === "hiragana") {
	    ch++;
	}
	return ch;
    }

    // 7. その他は1文字進める
    return ch + 1;
}

/* 
 * Alt+B (backward word movement) 用の境界判定関数。
 *
 * 日本語と英語が混在するテキストに対して、
 * 「編集しやすい文節的なまとまり（editing chunk）」の先頭を左方向に探索する。
 *
 * 挙動の基本方針：
 * - 英数字列は1語としてまとめて戻る
 * - カタカナ列も1語として扱う
 * - 句読点・記号はひとまとまりでスキップ
 * - 漢字列はひとまとまり
 * - ひらがな列は通常ひとまとまりだが、
 *   直前が漢字かつ長さが1〜2文字の場合は助詞とみなし、
 *   漢字と結合して「環境は」「近隣の」などの単位で戻る
 *
 * 目的：
 * - Ctrl+B（1文字単位）との差を維持しつつ、
 *   日本語でも自然なジャンプ単位で移動できるようにする
 * - 厳密な形態素解析ではなく、軽量で実用的な区切りを提供する
 */
function findWordBackwardBoundary(line, startCh) {
    let ch = startCh;

    if (ch <= 0) return 0;

    // 1. いまの位置の左隣から見る
    ch--;

    // 2. 空白は左に飛ばす
    while (ch >= 0 && getCharCategory(line[ch]) === "space") {
	ch--;
    }
    if (ch < 0) return 0;

    // 3. 句読点はひとまとまり
    if (getCharCategory(line[ch]) === "punct") {
	while (ch >= 0 && getCharCategory(line[ch]) === "punct") {
	    ch--;
	}
	return ch + 1;
    }

    // 4. 英数字列はひとまとまり
    if (getCharCategory(line[ch]) === "ascii") {
	while (ch >= 0 && getCharCategory(line[ch]) === "ascii") {
	    ch--;
	}
	return ch + 1;
    }

    // 5. カタカナ列はひとまとまり
    if (getCharCategory(line[ch]) === "katakana") {
	while (ch >= 0 && getCharCategory(line[ch]) === "katakana") {
	    ch--;
	}
	return ch + 1;
    }

    // 6. ひらがな列
    if (getCharCategory(line[ch]) === "hiragana") {
	const hiraEnd = ch + 1;

	while (ch >= 0 && getCharCategory(line[ch]) === "hiragana") {
	    ch--;
	}

	const hiraStart = ch + 1;
	const hiraLen = hiraEnd - hiraStart;
	const prevCat = ch >= 0 ? getCharCategory(line[ch]) : "bol";

	// 直前が漢字なら、短いひらがな(1〜2文字)は漢字側に含める
	// 例: 「環境は」なら「は」は独立させず「環境は」の先頭へ戻る
	if (prevCat === "kanji" && hiraLen <= 2) {
	    while (ch >= 0 && getCharCategory(line[ch]) === "kanji") {
		ch--;
	    }
	    return ch + 1;
	}

	// それ以外はひらがな列の先頭
	return hiraStart;
    }

    // 7. 漢字列
    if (getCharCategory(line[ch]) === "kanji") {
	while (ch >= 0 && getCharCategory(line[ch]) === "kanji") {
	    ch--;
	}
	return ch + 1;
    }

    // 8. その他は1文字戻る
    return ch;
}


module.exports = class EmacsLitePlugin extends Plugin {
    onload() {

	// 状態変数の追加
	this.markActive = false;
	this.markAnchor = null;

	// Ctrl+M: Return / Enter
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


	// Ctrl+A: visual line の左端へ移動
	this.addCommand({
	    id: "move-to-visual-line-start",
	    name: "Move to visual line start",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "a" }],
	    editorCallback: (editor) => {
		const cm = this.getEditorView();

		if (cm) {
		    cursorLineBoundaryBackward(cm);
		} else {
		    // fallback: 従来の論理行頭
		    const cursor = editor.getCursor();
		    editor.setCursor({ line: cursor.line, ch: 0 });
		}

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});
	

	// Ctrl+E: visual line の右端へ移動
	this.addCommand({
	    id: "move-to-visual-line-end",
	    name: "Move to visual line end",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "e" }],
	    editorCallback: (editor) => {
		const cm = this.getEditorView();

		if (cm) {
		    cursorLineBoundaryForward(cm);
		} else {
		    // fallback: 論理行末
		    const cursor = editor.getCursor();
		    const lineText = editor.getLine(cursor.line);
		    editor.setCursor({ line: cursor.line, ch: lineText.length });
		}

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});
	
	// Ctrl+F: 右へ1文字移動
	this.addCommand({
	    id: "cursor-forward",
	    name: "Move cursor forward by character",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "f" }],
	    editorCallback: (editor) => {
		const offset = editor.posToOffset(editor.getCursor());
		const newPos = editor.offsetToPos(offset + 1);

		editor.setCursor(newPos);

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});
	
	// Ctrl+B: 左へ1文字移動
	this.addCommand({
	    id: "cursor-backward",
	    name: "Move cursor backward by character",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "b" }],
	    editorCallback: (editor) => {
		const offset = editor.posToOffset(editor.getCursor());
		const newOffset = Math.max(offset - 1, 0);
		const newPos = editor.offsetToPos(newOffset);

		editor.setCursor(newPos);

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});

	// Ctrl+N: visual line で1行下へ移動
	this.addCommand({
	    id: "move-visual-line-down",
	    name: "Move visual line down",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "n" }],
	    editorCallback: (editor) => {
		const cm = this.getEditorView();

		if (cm) {
		    cursorLineDown(cm);
		} else {
		    // fallback: 論理行ベース
		    const cursor = editor.getCursor();
		    const maxLine = editor.lastLine();
		    const newLine = Math.min(cursor.line + 1, maxLine);
		    const lineLength = editor.getLine(newLine).length;
		    const newCh = Math.min(cursor.ch, lineLength);
		    editor.setCursor({ line: newLine, ch: newCh });
		}

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});

	// Ctrl+P: visual line で1行上へ移動
	this.addCommand({
	    id: "move-visual-line-up",
	    name: "Move visual line up",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "p" }],
	    editorCallback: (editor) => {
		const cm = this.getEditorView();

		if (cm) {
		    cursorLineUp(cm);
		} else {
		    // fallback: 論理行ベース
		    const cursor = editor.getCursor();
		    const newLine = Math.max(cursor.line - 1, 0);
		    const lineLength = editor.getLine(newLine).length;
		    const newCh = Math.min(cursor.ch, lineLength);
		    editor.setCursor({ line: newLine, ch: newCh });
		}

		if (this.markActive) {
		    this.syncMarkSelection(editor);
		}
	    },
	});
	
        // Ctrl+D: 右側の文字を削除
	this.addCommand({
            id: "delete-char-forward",
            name: "Delete character forward",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "d" }],
            editorCallback: (editor) => {
                const selection = editor.getSelection();

                // 選択範囲がある場合は、その範囲を削除
                if (selection && selection.length > 0) {
                    editor.replaceSelection("");
                    return;
                }

                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);

                // 行末で、かつ最終行でもある場合は何もしない
                const isEndOfLine = cursor.ch >= line.length;
                const isLastLine = cursor.line >= editor.lineCount() - 1;

                if (isEndOfLine && isLastLine) {
                    return;
                }

                // 通常ケース:
                // - 行中なら右1文字削除
                // - 行末なら次行との改行を削除（Emacs/Ctrl-d風）
                const from = { line: cursor.line, ch: cursor.ch };
                const to = isEndOfLine
                    ? { line: cursor.line + 1, ch: 0 }
                    : { line: cursor.line, ch: cursor.ch + 1 };

                editor.replaceRange("", from, to);
            },
        });

	// Ctrl+H: 左側の文字を削除
	this.addCommand({
	    id: "delete-char-backward",
	    name: "Delete character backward",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "h" }],
	    editorCallback: (editor) => {
		const selection = editor.getSelection();

		// 選択範囲がある場合は、その範囲を削除
		if (selection && selection.length > 0) {
		    editor.replaceSelection("");
		    return;
		}

		const cursor = editor.getCursor();

		// 文書先頭なら何もしない
		const isStartOfLine = cursor.ch === 0;
		const isFirstLine = cursor.line === 0;

		if (isStartOfLine && isFirstLine) {
		    return;
		}

		// 通常ケース:
		// - 行中なら左1文字削除
		// - 行頭なら前行との改行を削除（Emacs/Ctrl-h風というより Backspace 風）
		const from = isStartOfLine
		      ? { line: cursor.line - 1, ch: editor.getLine(cursor.line - 1).length }
		      : { line: cursor.line, ch: cursor.ch - 1 };

		const to = { line: cursor.line, ch: cursor.ch };

		editor.replaceRange("", from, to);
	    },
	});


	// Alt+F: Move cursor forward by chunk
	this.addCommand({
	    id: "cursor-chunk-forward",
	    name: "Move cursor forward by chunk",
	    hotkeys: [{ modifiers: ["Alt"], key: "f" }],
	    editorCallback: (editor) => {
		const cursor = editor.getCursor();

		function moveForwardOne(pos) {
		    const lineText = editor.getLine(pos.line);

		    // 同じ論理行内で1文字進む
		    if (pos.ch < lineText.length) {
			return { line: pos.line, ch: pos.ch + 1 };
		    }

		    // 次の論理行へ
		    if (pos.line < editor.lineCount() - 1) {
			return { line: pos.line + 1, ch: 0 };
		    }

		    // 文書末尾
		    return pos;
		}

		let pos = { line: cursor.line, ch: cursor.ch };

		for (let i = 0; i < 1000; i++) {
		    const lineText = editor.getLine(pos.line);
		    const newCh = findWordForwardBoundary(lineText, pos.ch);

		    // 同じ論理行内で前進できた
		    if (newCh > pos.ch) {
			editor.setCursor({ line: pos.line, ch: newCh });
			return true;
		    }

		    // 前進できないなら1文字先へ進めて再試行
		    const nextPos = moveForwardOne(pos);

		    // もう進めない
		    if (nextPos.line === pos.line && nextPos.ch === pos.ch) {
			editor.setCursor(pos);
			return true;
		    }

		    pos = nextPos;
		}

		return true;
	    }
	});

	// Alt+B: Move cursor backward by chunk
	this.addCommand({
	    id: "cursor-chunk-backward",
	    name: "Move cursor backward by chunk",
	    hotkeys: [{ modifiers: ["Alt"], key: "b" }],
	    editorCallback: (editor) => {
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

		    // 同じ行の中で後退できた
		    if (newCh < pos.ch) {
			editor.setCursor({ line: pos.line, ch: newCh });
			return true;
		    }

		    // 後退できないなら1文字前へ移動して再試行
		    const prevPos = moveBackwardOne(pos);

		    // もう戻れない
		    if (prevPos.line === pos.line && prevPos.ch === pos.ch) {
			editor.setCursor(pos);
			return true;
		    }

		    pos = prevPos;
		}

		return true;
	    }
	});

	// Alt+D: delete forward by 1 chunk
	this.addCommand({
	    id: "delete-chunk-forward",
	    name: "Delete chunk forward",
	    hotkeys: [{ modifiers: ["Alt"], key: "d" }],
	    editorCallback: (editor) => {
		const cursor = editor.getCursor();
		const from = { line: cursor.line, ch: cursor.ch };

		function moveForwardOne(pos) {
		    const lineText = editor.getLine(pos.line);

		    // 同じ論理行内で1文字進む
		    if (pos.ch < lineText.length) {
			return { line: pos.line, ch: pos.ch + 1 };
		    }

		    // 次の論理行へ
		    if (pos.line < editor.lineCount() - 1) {
			return { line: pos.line + 1, ch: 0 };
		    }

		    // 文書末尾
		    return pos;
		}

		let pos = { line: cursor.line, ch: cursor.ch };
		let to = pos;

		for (let i = 0; i < 1000; i++) {
		    const lineText = editor.getLine(pos.line);
		    const newCh = findWordForwardBoundary(lineText, pos.ch);

		    // 同じ行の中で前進できた
		    if (newCh > pos.ch) {
			to = { line: pos.line, ch: newCh };
			break;
		    }

		    // 前進できないなら1文字先へ進めて再試行
		    const nextPos = moveForwardOne(pos);

		    // もう進めない
		    if (nextPos.line === pos.line && nextPos.ch === pos.ch) {
			to = pos;
			break;
		    }

		    pos = nextPos;
		}

		// 何も削除できないなら終了
		if (to.line === from.line && to.ch === from.ch) {
		    return true;
		}

		editor.replaceRange("", from, to);
		editor.setCursor(from);
		return true;
	    }
	});

	// Alt+H: delete backward by 1 chunk	
	this.addCommand({
	    id: "delete-chunk-backward",
	    name: "Delete chunk backward",
	    hotkeys: [{ modifiers: ["Alt"], key: "h" }],
	    editorCallback: (editor) => {
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

		    // 同じ行の中で後退できた
		    if (newCh < pos.ch) {
			from = { line: pos.line, ch: newCh };
			break;
		    }

		    // 後退できないなら1文字前へ移動して再試行
		    const prevPos = moveBackwardOne(pos);

		    // もう戻れない
		    if (prevPos.line === pos.line && prevPos.ch === pos.ch) {
			from = pos;
			break;
		    }

		    pos = prevPos;
		}

		// 何も削除できないなら終了
		if (from.line === to.line && from.ch === to.ch) {
		    return true;
		}

		editor.replaceRange("", from, to);
		editor.setCursor(from);
		return true;
	    }
	});

	
	// Ctrl+Z: Undo
	this.addCommand({
	    id: "undo",
	    name: "Undo",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "z" }],
	    editorCallback: (editor) => {
		editor.undo();
	    },
	});

	// Ctrl+Shift+Z: Redo
	this.addCommand({
	    id: "redo",
	    name: "Redo",
	    hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "z" }],
	    editorCallback: (editor) => {
		editor.redo();
	    },
	});

	// 保持用の変数の宣言
        this.lastYankText = "";
	
	// Ctrl+K: カーソル位置から行末まで削除し、削除内容をクリップボードへ
	this.addCommand({
	    id: "kill-to-end-of-line",
	    name: "Kill to end of line",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "k" }],
	    editorCallback: (editor) => {
		const selection = editor.getSelection();

		// 選択範囲がある場合は、その範囲を削除してコピー
		if (selection && selection.length > 0) {
		    clipboard.writeText(selection);
		    editor.replaceSelection("");
		    return;
		}

		const cursor = editor.getCursor();
		const lineText = editor.getLine(cursor.line);
		const isEndOfLine = cursor.ch >= lineText.length;
		const isLastLine = cursor.line >= editor.lineCount() - 1;

		// 最終行末尾なら何もしない
		if (isEndOfLine && isLastLine) {
		    return;
		}

		let killedText = "";
		let from = { line: cursor.line, ch: cursor.ch };
		let to;

		if (isEndOfLine) {
		    // 行末なら改行を削除（次行と結合）
		    killedText = "\n";
		    to = { line: cursor.line + 1, ch: 0 };
		} else {
		    // 行の途中ならカーソル位置から行末まで削除
		    killedText = lineText.slice(cursor.ch);
		    to = { line: cursor.line, ch: lineText.length };
		}
		
		this.lastYankText = killedText;
		clipboard.writeText(killedText);
		editor.replaceRange("", from, to);
	    },
	});
	
	// Ctrl+W: 選択範囲をコピーして削除
        this.addCommand({
            id: "kill-region",
            name: "Kill region",
            hotkeys: [{ modifiers: ["Ctrl"], key: "w" }],
            editorCallback: (editor) => {
                const selection = editor.getSelection();

                if (!selection || selection.length === 0) {
                    return;
                }

                this.lastYankText = selection;
                clipboard.writeText(selection);
                editor.replaceSelection("");

		if (this.markActive) {
		    this.clearMark(editor);
		}
            },
        });

        // Alt+W: 選択範囲をコピーのみ
        this.addCommand({
            id: "copy-region",
            name: "Copy region",
            hotkeys: [{ modifiers: ["Alt"], key: "w" }],
            editorCallback: (editor) => {
                const selection = editor.getSelection();

                if (!selection || selection.length === 0) {
                    return;
                }

                this.lastYankText = selection;
                clipboard.writeText(selection);

		if (this.markActive) {
		    this.clearMark(editor);
		}
            },
        });

        // Ctrl+Y: 直前に kill / copy した内容を貼り付け
	this.addCommand({
	    id: "yank",
	    name: "Yank",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "y" }],
	    editorCallback: async (editor) => {
		let text = this.lastYankText;

		// lastYankTextになければ、clipboardから取得.
		// clipboard.readText() は非同期. asyncで扱う.
		if (!text) {
		    try {
			text = await navigator.clipboard.readText();
		    } catch (e) {
			return;
		    }
		}

		if (!text) return;

		editor.replaceSelection(text);

		if (this.markActive) {
		    this.clearMark(editor);
		}
	    },
	});
	
	// Ctrl+C: コピーして mark 解除.
	// defaultでCtrl+Cはcopyだが、MarkSetの解除のために自作cmdとして登録.
	this.addCommand({
	    id: "copy-region-ctrl-c",
	    name: "Copy region (Ctrl+C)",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "c" }],
	    editorCallback: (editor) => {
		const selection = editor.getSelection();

		if (!selection || selection.length === 0) {
		    return;
		}

		this.lastYankText = selection;
		clipboard.writeText(selection);

		if (this.markActive) {
		    this.clearMark(editor);
		}
	    },
	});


	// Ctrl+L: カーソル位置を画面中央付近に表示
	this.addCommand({
	    id: "recenter-cursor",
	    name: "Recenter cursor",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "l" }],
	    editorCallback: (editor) => {
		const cursor = editor.getCursor();

		// CodeMirror系の scrollIntoView を使って、
		// カーソル位置が見えるようにしつつ中央寄せを狙う
		editor.scrollIntoView(
		    { from: cursor, to: cursor },
		    true
		);

		// 少し待ってから中央へ再調整
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

	// Ctrl+Xを選択があるときだけcut(Windows標準)に変更.
	// DefaultはCtrl+Cが一行全体の切り取り.
	this.registerEditorExtension(
	    Prec.high(
		keymap.of([
		    {
			key: "Ctrl-x",
			run: (view) => {
			    const hasSelection = view.state.selection.ranges.some(
				(r) => !r.empty
			    );

			    if (!hasSelection) {
				return true; // 選択がなければ何もしない
			    }

			    document.execCommand("cut");
			    return true;
			},
		    },
		])
	    )
	);
	
	// Ctrl+< : 文書の先頭へ移動
	this.addCommand({
	    id: "go-to-document-start",
	    name: "Go to document start",
	    hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "," }],
	    editorCallback: (editor) => {
		editor.setCursor({ line: 0, ch: 0 });
	    },
	});

	
	// Ctrl+> : 文書の末尾へ移動
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

	// Ctrl+Space: mark 開始
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

	// Ctrl+G: mark 解除
	this.addCommand({
	    id: "cancel-mark",
	    name: "Cancel mark",
	    hotkeys: [{ modifiers: ["Ctrl"], key: "g" }],
	    editorCallback: (editor) => {
		if (!this.markActive) return;
		this.clearMark(editor);
	    },
	});

	// mark中にカーソル移動したら、移動後に選択範囲を同期
	this.registerDomEvent(document, "keyup", (evt) => {
	    if (!this.markActive) return;

	    // mark開始/解除キー自身は除外
	    if (evt.ctrlKey && (evt.key === "g" || evt.code === "Space")) {
		return;
	    }

	    const editor = this.getActiveEditor();
	    if (!editor) return;

	    this.syncMarkSelection(editor);
	});
	
    }

    getActiveEditor() {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	return view ? view.editor : null;
    }

    syncMarkSelection(editor) {
	if (!this.markActive || !this.markAnchor) return;

	const cursor = editor.getCursor();

	editor.setSelection(
            { line: this.markAnchor.line, ch: this.markAnchor.ch },
            { line: cursor.line, ch: cursor.ch }
	);
    }

    clearMark(editor) {
	const cursor = editor.getCursor("to");
	editor.setCursor(cursor);
	this.markActive = false;
	this.markAnchor = null;
    }

    getEditorView() {
	const view = this.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) return null;

	// Obsidian内部のCM6 EditorView
	return view.editor?.cm ?? null;
    }

};
