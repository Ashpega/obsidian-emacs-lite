# obsidian-emacs-lite (for Windows users)

Emacs-like keybindings for Obsidian, designed for Windows users.

This plugin provides a lightweight Emacs-style editing experience while respecting common Windows shortcuts as much as possible.

---

## Purpose

This plugin aims to:

- Bring essential Emacs navigation and editing behaviors to Obsidian
- **Respect Windows default shortcuts as much as possible**
- Provide stable and predictable behavior using CodeMirror keymap
- Allow users to selectively enable/disable non-native extensions

It is not a full Emacs emulation, but a **practical and stable subset**.

---

## Features

### Implemented Keybinds

- Cursor movement  
  - `Ctrl+F (forward) / B (backward) / P (upward) / N (downward)`
  - `Ctrl+A (beginning of line) / E (end of line)`
  - `Ctrl+< (beginning of note) / Ctrl+> (end of note)`

- Word / chunk movement  
  - `Alt+F (forward) / B (backward)`
  
- Enter
  - `Ctrl+M (enter)`

- Deletion  
  - `Ctrl+D (forward)`
  - `Ctrl+H (backward)`
	
- Deletion by chunk  
  - `Alt+D (forward)`
  - `Alt+H (backward)`

- Selection
  - `Ctrl+; (from cursor point to end of line)`

- Kill / Yank  
  - `Ctrl+K (cut from cursor point to end of line)`
    - Kill-ring is not implemented.
  - `Ctrl+Y (yank)` 

- Mark system  
  - `Ctrl+Space (mark set)`, 
  - `Ctrl+G (clear mark set)`

- Cut/Copy region
  - `Ctrl+W (cut selected region)`
  - `Alt+W (copy selected region)`

- View control  
  - `Ctrl+L (recenter the cursor in the editor view)`

---

### Visual vs Logical line mode

Switch between:

- **Visual line mode** (wrapped line based)
- **Logical line mode** (actual line based)

✔ No reload required  
✔ Applies to movement, selection, and kill operations

---

### Key repeat support

- Press-and-hold behavior for selected keys
- Can be enabled/disabled in settings

✔ No reload required  
✔ Applies to movement, selection, and kill operations

---

### Configurable hotkey groups

You can toggle the following extensions:

- **Extended delete keys**  
  `Ctrl+H`, `Alt+H`

- **Extended selection key**  
  `Ctrl+;`

- **System override (Windows-style)**  
  `Ctrl+X`, `Ctrl+C`

When disabled, native Obsidian / OS behavior is preserved.

---

## Other features

- Pressing Ctrl+C clears the selection.

- Regarding Ctrl+X
Ctrl+X typically cuts the entire logical line in Obsidian by default. In this plugin, it cuts the selected range, similar to Windows.

- Regarding Ctrl+A/E
In Visual mode, pressing Ctrl+E moves the cursor to the end of the visual line on the first press and to the end of the logical line on the second press. 
Similarly, pressing Ctrl+A moves the cursor to the beginning of the visual line on the first press and to the beginning of the logical line on the second press.
This behaviors remains the same even when the mark is active.

---

## Installation

1. Copy this plugin into your vault:

.obsidian/plugins/obsidian-emacs-lite/

2. Open Settings.

3. Click the refresh icon (the rotating arrow) in the "installed plugins" section.

4. Once the plugin name (Emacs lite) appears, enable it.

5. Adjust settings (key repeat, line mode, hotkey toggles) as needed.

---

## Notes

- This plugin is optimized for Windows environments

- Some behaviors intentionally differ from full Emacs for practicality and stability

- Undo(Ctrl+Z)/Redo(Ctrl+Shift+Z) currently use native Obsidian behavior

- Ctrl+V remains the default Windows shortcut (Paste)

- Alt+V (move up by one page) is not implemented (to remain consistent with the decision not to override Ctrl+V).

---

## Future Work

- Enhanced undo behavior
- Additional customization options

---

## License

MIT
