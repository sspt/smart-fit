import { t } from "./i18n";
import { LanguagePicker } from "./i18n/LanguagePicker";
import { AccountPanel } from "./Accounts";
import { accountState } from "./accountClient";
import type { ReactNode } from "react";
type Props = {
  busy?: boolean;
  units: ReactNode;
  connection?: ReactNode;
  backup: ReactNode;
  refresh: ReactNode;
  install?: ReactNode;
  erase: ReactNode;
};
export function SettingsLayout(p: Props) {
  return (
    <section className="clean-settings">
      <div className="panel settings">
        <section className="settings-group">
          <h2>{t("Preferences")}</h2>
          {p.units}
          <LanguagePicker disabled={p.busy} />
        </section>
        <AccountPanel disabled={p.busy} />
        {p.connection}
        <section className="settings-group">
          <h2>{t("Your data")}</h2>
          <p className="subtle">
            {accountState().user
              ? "Saved to your account and available offline. Keep a backup."
              : "Stored on this device. Keep a backup."}
          </p>
          <div className="actions">{p.backup}</div>
        </section>
        <details className="settings-tools">
          <summary>{t("App & data tools")}</summary>
          <div className="settings-tools-content">
            <p className="subtle">
              Refresh the app without deleting your data.
            </p>
            <div className="actions">
              {p.refresh}
              {p.install}
            </div>
            <div className="settings-delete">{p.erase}</div>
          </div>
        </details>
      </div>
    </section>
  );
}
