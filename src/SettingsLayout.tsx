import type { ReactNode } from "react";
type Props = {
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
      <h1>Settings</h1>
      <div className="panel settings">
        <section className="settings-group">
          <h2>Preferences</h2>
          {p.units}
        </section>
        {p.connection}
        <section className="settings-group">
          <h2>Your data</h2>
          <p className="subtle">Stored on this device. Keep a backup.</p>
          <div className="actions">{p.backup}</div>
        </section>
        <details className="settings-tools">
          <summary>App & data tools</summary>
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
