// Adapt the pinned production snapshot. Each replacement must match once.
export function applyTrainingUX(replace) {
  const t = (key) => `__routeRelease.t(${JSON.stringify(key)})`;

  replace(
    /                              c\.jsxs\("div", \{\n                                className: "programme-duration-tile",[\s\S]*?\n                              \}\),\n/,
    "",
  );
  replace(
    /                                      __routeRelease\.uiText\(w\.kind\),\n                                      " \\xB7 ",\n                                      w\.blocks\.length,\n                                      __routeRelease\.uiText\(" segments \\xB7"\),\n                                      " ",\n                                      fi\(w\),/,
    `                                      programmeDurationLabel(w, fi(w)),
                                      " · ",
                                      w.blocks.length,
                                      " ",
                                      w.blocks.length === 1 ? ${t("segment")} : ${t("segments")},
                                      " · ",
                                      __routeRelease.t(w.kind),`,
  );
  replace(
    /children: __routeRelease\.uiText\(\n                                      w\.name,\n                                      \[\],\n                                      !0,\n                                    \),\n                                  \}\),\n                                  c\.jsx\("div", \{\n                                    className: "mini-bars"/,
    `children: programmeDisplayName(w),
                                  }),
                                  c.jsx("div", {
                                    className: "mini-bars"`,
  );
  replace(
    /                                      c\.jsx\("button", \{\n                                        onClick: \(\) =>\n                                          Ft\(__routeRelease\.copyProgramme\(w\)\),[\s\S]*?onClick: \(\) => Nr\(void 0, w\),\n                                        children: "\\u203A",\n                                      \}\),/,
    `                                      c.jsx("button", {
                                        className: "primary prepare-workout",
                                        "aria-label": ${t("Prepare workout")} + ": " + programmeDisplayName(w),
                                        disabled: qt || !!q,
                                        onClick: () => Nr(void 0, w),
                                        children: ${t("Prepare workout")},
                                      }),
                                      c.jsxs("details", {
                                        className: "programme-card-menu",
                                        children: [
                                          c.jsx("summary", {"aria-label": __routeRelease.uiText("Edit programme") + ": " + programmeDisplayName(w), children: "⋯"}),
                                          c.jsx("button", {
                                            onClick: (event) => {
                                              const menu = event.currentTarget.closest("details");
                                              menu.open = false;
                                              menu.querySelector("summary").focus();
                                              Ft(__routeRelease.copyProgramme(w));
                                            },
                                            children: __routeRelease.uiText("Edit programme"),
                                          }),
                                        ],
                                      }),`,
  );
  replace(
    "    jr =\n",
    `    lastProgramme = ea.find((programme) =>
      programme.id === bt?.programmeId && programme.kind === bt.kind &&
      (!It || programme.kind === Je)),
    lastScene = lastProgramme && F.find((scene) =>
      scene.id === bt.sceneId && scene.kind === lastProgramme.kind),
    jr =
`,
  );
  replace(
    "                  onStart: () => Nr(),",
    `                  lastWorkout: lastScene ? {
                    name: programmeDisplayName(lastProgramme),
                    detail: programmeDurationLabel(lastProgramme, fi(lastProgramme)) + " · " + __routeRelease.t(lastProgramme.kind),
                  } : null,
                  onStart: () => lastScene ? Nr(lastScene, lastProgramme) : Nr(),`,
  );

  replace(
    /            c\.jsx\("p", \{\n              children: \[\n                __routeRelease\.uiText\(\n                  "First, connect the machine[\s\S]*?\]\[i\],\n            \}\),/,
    (match) =>
      match
        .replace('c.jsx("p"', 'i !== 0 && c.jsx("p"')
        .replace(
          /__routeRelease\.uiText\(\s*"First, connect[^\n]*\n\s*\),/,
          "null,",
        ),
  );
  replace(
    /__routeRelease\.uiText\("Connect equipment"\)(?=,\n          \),\n          m\.createElement)/,
    `${t("Connect {equipment} via Bluetooth")}.replace(
                    "{equipment}", () => __routeRelease.t(u.kind)
                  )`,
  );
  replace(
    /          m\.createElement\(\n            "button",\n            \{ onClick: u\.onExport \},\n            __routeRelease\.uiText\("Export diagnostics"\),\n          \),\n        \),/,
    `        ),
        m.createElement("details", {className: "connection-help"},
          m.createElement("summary", null, ${t("Connection help")}),
          m.createElement("button", {onClick: u.onExport}, __routeRelease.uiText("Export diagnostics")),
        ),`,
  );
  replace(
    '__routeRelease.uiText("\\u25CB Offline equipment")',
    t("No Bluetooth connection"),
  );

  replace(
    "function mh({ route: i, onPreview: r }) {",
    `function mh({ route: i, onPreview: r }) {
  const title = routeCardTitle(i);
  const activity = routeCardActivity(i);`,
  );
  replace(
    /\.replace\("\{title\}", \(\) => __routeRelease\.uiText\(i\.name, \[\], true\)\)/,
    '.replace("{title}", () => title)',
  );
  replace(
    /          c\.jsxs\("span", \{ className: "route-length", children: Va\(i\) \}\),\n/,
    "",
  );
  replace(
    /          c\.jsxs\("small", \{\n            children: \[\n              __routeRelease\.uiText\(i\.kind\),[\s\S]*?          c\.jsxs\("p", \{ children: \[__routeRelease\.routeDetails\(i\)\] \}\),/,
    `          c.jsx("h3", {children: title}),
          c.jsx("small", {children: activity + " · " + routeCardDuration(i) + (i.format === "route" ? "" : " · " + __routeRelease.t("Scenic loop"))}),
          `,
  );

  replace(
    '__routeRelease.t("The video repeats if you keep training.")',
    t("The video restarts if the workout continues."),
  );

  replace(
    'ht(Qe.units ?? __routeRelease.uiText("km"))',
    'ht(Qe.units === "mi" ? "mi" : "km")',
  );
  replace(
    "                      initialRouteId: q.sceneryId,",
    `                      initialRouteId: q.sceneryId,
                      displayUnits: Ne,
                      connectionAlert: !rt && !It && en && c.jsxs("div", {
                        className: "immersion-connection-alert",
                        children: [
                          c.jsx("span", {role: "status", children: ${t("Connection lost · Recording paused")}}),
                          c.jsx("button", {disabled: qt, onClick: () => void Ge(Ut), children: ${t("Reconnect equipment")}}),
                        ],
                      }),`,
  );
  replace(
    "  continuationControls,\n  nextCue: lt,",
    `  continuationControls,
  displayUnits,
  connectionAlert,
  nextCue: lt,`,
  );
  replace(
    "time: K, speed: C, running: F, busy: Z,",
    "time: K, speed: C, power: r, kind: I, units: displayUnits, running: F, busy: Z,",
  );
  replace(
    "children: [continuationControls, c.jsx(__feedback.IntervalCue, {text: lt}),",
    "children: [connectionAlert, continuationControls, c.jsx(__feedback.IntervalCue, {text: lt}),",
  );

  replace(
    /                c\.jsxs\("div", \{\n                  className: "history-overview"/,
    `                Ue.some((workout) => !workout.demo) && c.jsxs("div", {
                  className: "history-overview"`,
  );
  replace(
    /                c\.jsx\(__feedback\.WeeklyProgress, \{\n                  history: Ue\.filter\(\(w\) => !w\.demo\),\n                \}\),/,
    "                Ue.some((workout) => !workout.demo) && c.jsx(__feedback.WeeklyProgress, { history: Ue.filter((workout) => !workout.demo) }),",
  );
  replace(
    /                          onClick: \(\) => K\("Train"\),\n                          className: "journal-icon",[\s\S]*?                            size: 19,\n                          \}\),/,
    `                          onClick: () => K("Programmes"),
                          className: "primary",
                          children: ${t("Choose your first workout")},`,
  );
  replace(
    /                                      w\.status,\n                                      " \\xB7 ",\n                                      w\.samples\.length,\n                                      " ",\n                                      __routeRelease\.uiText\("samples"\),/,
    `                                      workoutStatus(w.status),
                                      ...workoutDistanceLabel(w, Ne),`,
  );
}
