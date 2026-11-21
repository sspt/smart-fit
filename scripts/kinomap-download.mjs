import { chromium } from "playwright";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export async function saveDownload(download, directory) {
  // Playwright waits for the transfer to complete before returning its path.
  const source = await download.path();
  if (!source) throw new Error("The browser did not complete this download.");
  const destination = resolve(directory, basename(download.suggestedFilename()));
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  return destination;
}

async function main() {
  const directory = resolve(process.argv[2] || "kinomap-downloads");
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const transfers = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    context.on("page", page => {
      page.on("download", download => {
        transfers.push(saveDownload(download, directory).then(path => {
          console.log("Saved", path);
        }).catch(error => {
          process.exitCode = 1;
          console.error(error.code === "EEXIST" ? "File already exists." : "Download failed.");
        }));
      });
    });
    const page = await context.newPage();
    await page.goto("https://www.kinomap.com/", { waitUntil: "domcontentloaded" });
    await terminal.question("Sign in, start any available file exports, then press Enter here to finish. ");
    await Promise.all(transfers);
    if (!transfers.length) {
      console.error("No browser file download was started.");
      process.exitCode = 1;
    }
  } finally {
    terminal.close();
    await browser.close();
  }
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
