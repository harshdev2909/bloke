/**
 * Hall of founders: historical founders shown with the Founder archetype. Not Blokes and not
 * tradeable; living people appear only when they list and claim their own profile (A12). Portraits
 * are public-domain works from Wikimedia Commons, stippled by scripts/art/stipple.mjs --mask oval.
 */
export interface HallEntry {
  name: string;
  years: string;
  founded: string;
  src: string;
  ratio: number;
  credit: string;
}

export const HALL: HallEntry[] = [
  { name: "Benjamin Franklin", years: "1706–1790", founded: "The first US lending library, a fire company and a university", src: "/art/hall/franklin.png", ratio: 1040 / 1152, credit: "Joseph Duplessis, 1778. Public domain." },
  { name: "Ada Lovelace", years: "1815–1852", founded: "The first published computer program", src: "/art/hall/lovelace.png", ratio: 1040 / 1344, credit: "Alfred Edward Chalon, c. 1840. Public domain." },
  { name: "Andrew Carnegie", years: "1835–1919", founded: "Carnegie Steel", src: "/art/hall/carnegie.png", ratio: 1040 / 1172, credit: "Theodore C. Marceau, 1913. Public domain." },
  { name: "Thomas Edison", years: "1847–1931", founded: "General Electric and the first industrial research lab", src: "/art/hall/edison.png", ratio: 1040 / 1198, credit: "Louis Bachrach, c. 1922. Public domain." },
  { name: "Nikola Tesla", years: "1856–1943", founded: "Tesla Electric Light & Manufacturing", src: "/art/hall/tesla.png", ratio: 1040 / 1254, credit: "Napoleon Sarony, c. 1890. Public domain." },
  { name: "Henry Ford", years: "1863–1947", founded: "Ford Motor Company", src: "/art/hall/ford.png", ratio: 1040 / 1196, credit: "Hartsook, 1919. Public domain." },
];
