/**
 * Reproduction: a configured city whose board spelling carries a diacritic is
 * never matched, so 100% of that city's scraped results are rejected as
 * `no_city_match`.
 *
 * `tokenizeLocation` (shared/src/search-cities.ts) lowercases and then squashes
 * everything outside `[a-z0-9]` to a space, with no Unicode folding, so an
 * accented letter becomes a TOKEN BREAK rather than its ASCII base: "Málaga"
 * tokenizes to ["m", "laga"]. The requested city "Malaga" is ["malaga"], which
 * is not a contiguous run inside it, so the city check fails.
 *
 * It hides well because the mangling is applied to BOTH sides — type the accent
 * on both and the two strings agree on their mangling and match. The failing
 * case is the ordinary one: the user types the ASCII spelling into the Cities
 * field (which is also what is sent to LinkedIn, where it resolves correctly)
 * and the board answers with its own accented canonical spelling.
 *
 * Measured against the prod Apify datasets on 2026-08-29: 28 of 28 rows whose
 * location was "Málaga, Andalusia, Spain" or "Greater Málaga Metropolitan Area"
 * were rejected on a Spain profile whose city list contains "Malaga".
 *
 * Exits non-zero while the bug exists.
 */

import { matchJobLocationIntent } from "@shared/job-matching";
import { createLocationIntentFromLegacyInputs } from "@shared/location-domain";

interface Case {
  country: string;
  cities: string[];
  location: string;
  why: string;
}

// Each pairs a city as a user types it with the spelling its board returns.
const CASES: Case[] = [
  {
    country: "spain",
    cities: ["Barcelona", "Madrid", "Valencia", "Malaga"],
    location: "Málaga, Andalusia, Spain",
    why: "the prod case: 28 of 28 rows rejected",
  },
  {
    country: "spain",
    cities: ["Barcelona", "Madrid", "Valencia", "Malaga"],
    location: "Greater Málaga Metropolitan Area",
    why: "the same city as a LinkedIn metro string",
  },
  {
    country: "switzerland",
    cities: ["Zurich"],
    location: "Zürich, Switzerland",
    why: "German umlaut",
  },
  {
    country: "poland",
    cities: ["Krakow"],
    location: "Kraków, Lesser Poland, Poland",
    why: "Polish acute",
  },
  {
    country: "sweden",
    cities: ["Malmo"],
    location: "Malmö, Skåne County, Sweden",
    why: "Swedish diaeresis",
  },
  {
    country: "austria",
    cities: ["Sankt Polten"],
    location: "Sankt Pölten, Lower Austria, Austria",
    why: "the case already noted in the project memory as unfixed",
  },
  // The reverse direction: the user pastes the accented spelling and the board
  // answers in ASCII.
  {
    country: "spain",
    cities: ["Málaga"],
    location: "Malaga, Andalusia, Spain",
    why: "accented city configured, ASCII location returned",
  },
];

const failures: string[] = [];

for (const testCase of CASES) {
  const intent = createLocationIntentFromLegacyInputs({
    country: testCase.country,
    searchCities: testCase.cities,
    matchStrictness: "exact_only",
    workplaceTypes: ["remote", "hybrid", "onsite"],
  });
  const result = matchJobLocationIntent(
    { location: testCase.location },
    intent,
  );
  if (!result.matched) {
    failures.push(
      `  ${JSON.stringify(testCase.location)} vs cities ${JSON.stringify(testCase.cities)} -> ${result.reasonCode} (${testCase.why})`,
    );
  }
}

// Guards against an over-broad "fix". Folding must widen the SPELLING of a
// match, never the set of places that count as one — a prefix or substring
// rule would pass the cases above and quietly accept half of Spain.
const overWidened: string[] = [];
const mustReject: Array<{
  country: string;
  cities: string[];
  location: string;
  why: string;
}> = [
  {
    country: "spain",
    cities: ["Malaga"],
    location: "Malagón, Castilla-La Mancha, Spain",
    why: "a different town sharing a prefix with the requested city",
  },
  {
    country: "spain",
    cities: ["Barcelona", "Madrid", "Valencia", "Malaga"],
    location: "Sant Cugat del Vallès, Catalonia, Spain",
    why: "an accented town nobody asked for",
  },
  {
    country: "germany",
    cities: ["Leon"],
    location: "Leonberg, Baden-Württemberg, Germany",
    why: "a genuine superstring: 'leonberg' CONTAINS 'leon', so a substring rule would wrongly keep it",
  },
  {
    country: "germany",
    cities: ["Munich"],
    location: "München, Bavaria, Germany",
    why: "an exonym: folding is a normalization, not a translation",
  },
];

for (const testCase of mustReject) {
  const intent = createLocationIntentFromLegacyInputs({
    country: testCase.country,
    searchCities: testCase.cities,
    matchStrictness: "exact_only",
    workplaceTypes: ["remote", "hybrid", "onsite"],
  });
  if (matchJobLocationIntent({ location: testCase.location }, intent).matched) {
    overWidened.push(
      `  ${JSON.stringify(testCase.location)} was KEPT on cities ${JSON.stringify(testCase.cities)} (${testCase.why})`,
    );
  }
}

if (overWidened.length > 0) {
  console.error(
    `FAIL: folding widened the set of places, not just their spelling:\n${overWidened.join("\n")}`,
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.error(
    `FAIL: ${failures.length} location(s) that name a configured city were rejected:\n${failures.join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `PASS: all ${CASES.length} accented/ASCII city spellings matched their configured city, and all ${mustReject.length} over-widening guards still reject.`,
);
