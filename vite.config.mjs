import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { localizeUI, shouldLocalizeSource } from "./scripts/localize-ui.mjs";

const messages = JSON.parse(
  readFileSync(new URL("./src/i18n/uiMessages.json", import.meta.url)),
);

export default defineConfig({
  plugins: [
    {
      name: "kwest-ui-localization",
      enforce: "pre",
      transform(source, filename) {
        if (!shouldLocalizeSource(filename)) return;
        const localized = localizeUI(source, filename, {
          callee: "__kwestText",
          hasMessage: (key) => Object.hasOwn(messages, key),
        });
        if (localized !== source)
          return (
            'import { uiText as __kwestText } from "/src/i18n/index.ts";\n' +
            localized
          );
      },
    },
  ],
});
