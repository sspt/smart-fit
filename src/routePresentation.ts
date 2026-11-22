import { getActiveLocale, getLanguage, t, type Language } from "./i18n";
import type { VideoRoute } from "./videoRoutes";

export const lengthCategories = ["short", "medium", "long"] as const;
export const activityTypes = ["ride", "run", "walk", "row"] as const;
export type LengthCategory = (typeof lengthCategories)[number];
export type ActivityType = (typeof activityTypes)[number];
export type RouteLocation = {
  name: string;
  region?: string;
  country?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  source?: string;
};

const names = {
  en: [
    "Short|Medium|Long",
    "Ride|Run|Walk|Row",
    "{length} {activity} in {place}",
  ],
  es: [
    "corto|medio|largo",
    "Paseo en bici|Entrenamiento de carrera|Paseo a pie|Recorrido de remo",
    "{activity} {length} en {place}",
  ],
  pt: [
    "curto|médio|longo",
    "Passeio de bicicleta|Treino de corrida|Percurso a pé|Percurso de remo",
    "{activity} {length} em {place}",
  ],
  fr: [
    "courte|moyenne|longue",
    "Sortie à vélo|Course à pied|Marche|Sortie en aviron",
    "{activity} {length} à {place}",
  ],
  it: [
    "breve|medio|lungo",
    "Giro in bici|Allenamento di corsa|Percorso a piedi|Percorso di canottaggio",
    "{activity} {length} a {place}",
  ],
  pl: [
    "Krótka|Średnia|Długa",
    "trasa rowerowa|trasa biegowa|trasa spacerowa|trasa wioślarska",
    "{length} {activity} · {place}",
  ],
  de: [
    "Kurze|Mittlere|Lange",
    "Radtour|Laufstrecke|Wanderung|Ruderstrecke",
    "{length} {activity} in {place}",
  ],
  nl: [
    "Korte|Middellange|Lange",
    "fietsrit|hardlooproute|wandeling|roeitocht",
    "{length} {activity} in {place}",
  ],
} satisfies Record<Language, [string, string, string]>;

export function routeName(route: VideoRoute, language = getLanguage()): string {
  if (
    language === "en" ||
    !route.lengthCategory ||
    !route.activityType ||
    !route.location?.name
  )
    return t(route.name, language);
  const [lengths, activities, pattern] = names[language];
  return pattern.replace(/\{(length|activity|place)\}/g, (_, key) => {
    if (key === "length")
      return lengths.split("|")[
        lengthCategories.indexOf(route.lengthCategory!)
      ];
    if (key === "activity")
      return activities.split("|")[activityTypes.indexOf(route.activityType!)];
    return route.location!.name;
  });
}

export function routeDetails(route: VideoRoute): string {
  const locale = getActiveLocale();
  let country = route.location?.country ?? route.country;
  if (route.location?.countryCode) {
    country =
      new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(
        route.location.countryCode,
      ) ?? country;
  }
  const distance =
    route.distanceKm == null
      ? undefined
      : new Intl.NumberFormat(locale, {
          maximumFractionDigits: 2,
          style: "unit",
          unit: "kilometer",
        }).format(route.distanceKm);
  return [
    ...new Set(
      [route.location?.name, route.location?.region, country, distance].filter(
        Boolean,
      ),
    ),
  ].join(" · ");
}
