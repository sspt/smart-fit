import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { WeightLossBuilder } from "./WeightLossBuilder";
import type { Kind, Programme } from "./store";

export function ProgrammeChoice({
  kind,
  disabled,
  onClose,
  onManual,
  onAutomatic,
}: {
  kind: Kind;
  disabled: boolean;
  onClose: () => void;
  onManual: () => void;
  onAutomatic: (programme: Programme) => void;
}) {
  const [automatic, setAutomatic] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add("editing");
    dialog.current?.focus();
    return () => {
      document.body.classList.remove("editing");
      previous?.focus();
    };
  }, []);
  return (
    <div className="editor-backdrop">
      <section
        className="programme-choice"
        role="dialog"
        aria-modal="true"
        aria-label={t("Create programme")}
        tabIndex={-1}
        ref={dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary",
              ) ?? [],
            ).filter((element) => element.getClientRects().length);
            const first = controls[0],
              last = controls[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="programme-choice-header">
          <button type="button" onClick={onClose}>
            {t("Close")}
          </button>
          <strong>{t("Create programme")}</strong>
        </div>
        <div className="programme-choice-content">
          {!automatic ? (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setAutomatic(true)}
              >
                {t("Automatic weight-loss programme")}
              </button>
              <button type="button" disabled={disabled} onClick={onManual}>
                {t("Manually customised programme")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setAutomatic(false)}>
                {t("Back")}
              </button>
              <WeightLossBuilder
                initialKind={kind}
                disabled={disabled}
                initiallyOpen
                onCreate={onAutomatic}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
