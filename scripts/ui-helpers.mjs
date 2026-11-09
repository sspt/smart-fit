export async function openLibrary(page) {
  if (
    await page
      .getByRole("heading", { name: "Your programmes", exact: true })
      .isVisible()
  )
    return;
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  if (
    await nav.getByRole("button", { name: "Library", exact: true }).isVisible()
  )
    await nav.getByRole("button", { name: "Library", exact: true }).click();
  else {
    await nav.getByRole("button", { name: "Home", exact: true }).click();
    await page.getByRole("button", { name: "Programmes & editor" }).click();
  }
  await page
    .getByRole("heading", { name: "Your programmes", exact: true })
    .waitFor();
}
export async function collectProgrammes(page) {
  await openLibrary(page);
  const pages = page.getByRole("group", { name: "Programme pages" });
  while (
    await pages
      .getByRole("button", { name: "Previous programme pages" })
      .isEnabled()
  )
    await pages
      .getByRole("button", { name: "Previous programme pages" })
      .click();
  const names = [];
  while (true) {
    names.push(...(await page.locator(".cards h3").allTextContents()));
    if (
      await pages
        .getByRole("button", { name: "Next programme pages" })
        .isDisabled()
    )
      break;
    await pages.getByRole("button", { name: "Next programme pages" }).click();
  }
  while (
    await pages
      .getByRole("button", { name: "Previous programme pages" })
      .isEnabled()
  )
    await pages
      .getByRole("button", { name: "Previous programme pages" })
      .click();
  return names;
}
