// Menu-bar presence for the shell: a Tray whose menu is the pure model in
// lib/tray-menu.ts (compiled to electron/gen). This module only binds the
// descriptors to real Electron objects; every decision about labels and
// enablement lives (and is tested) in the lib.

const { Tray, Menu, nativeImage } = require("electron");
const path = require("path");

// getState() is read on every rebuild so the menu always reflects the latest
// renderer report. actions maps TrayAction ids to main-process handlers.
// Throws when electron/gen is missing (gitignored; built by the preelectron
// hook): the require lives here, not at module load, so a bare `npx electron .`
// on a clean checkout still boots the shell and can degrade gracefully.
function createTray({ getState, toggleHotkey, actions }) {
  const { buildTrayMenu } = require("./gen/tray-menu");
  // createFromPath picks up the @2x sibling for Retina; the Template name (and
  // the explicit flag) lets macOS recolor the glyph for menu-bar appearance.
  const icon = nativeImage.createFromPath(
    path.join(__dirname, "assets", "trayTemplate.png")
  );
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("Capturia");

  function update() {
    const template = buildTrayMenu(getState(), toggleHotkey).map((item) => {
      if (item.type === "separator") return { type: "separator" };
      const entry = { label: item.label, enabled: item.enabled !== false };
      if (item.accelerator) {
        entry.accelerator = item.accelerator;
        // The shortcut is registered globally in main.js; the menu shows it
        // only as a hint (avoids a duplicate registration on Win/Linux).
        entry.registerAccelerator = false;
      }
      const handler = item.action && actions[item.action];
      if (handler) entry.click = () => handler();
      return entry;
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  update();
  return {
    update,
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray };
