import { getLanguage, languages, setLanguage, t, type Language } from "./index";

export function LanguagePicker({ disabled }: { disabled?: boolean }) {
  return (
    <label>
      {t("Language")}
      <select
        disabled={disabled}
        value={getLanguage()}
        onChange={(event) => {
          setLanguage(event.currentTarget.value as Language);
          window.location.reload();
        }}
      >
        {Object.entries(languages).map(([code, name]) => (
          <option key={code} value={code} lang={code}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
