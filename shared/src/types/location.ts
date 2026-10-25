import type {
  LocationGeoScope,
  LocationMatchStrictness,
  LocationSourceCapabilities,
  LocationSourcePlan,
  LocationWorkplaceType,
} from "../location-domain.js";

export {
  buildLocationEvidence,
  createLocationIntent,
  createLocationIntentFromLegacyInputs,
  getDefaultLocationSourceCapabilities,
  getLegacyLocationSelection,
  getPrimaryLocationLabel,
  LOCATION_GEO_SCOPE_VALUES,
  LOCATION_GEO_SCOPE_VALUES as GEO_SCOPE_VALUES,
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
  LOCATION_WORKPLACE_TYPE_VALUES,
  type LocationEvidence,
  type LocationEvidenceEntry,
  type LocationEvidenceEntryKind,
  type LocationEvidenceInput,
  type LocationEvidenceQuality,
  type LocationGeoScope,
  type LocationIntent,
  type LocationIntentInput,
  type LocationMatchResult,
  type LocationMatchStrictness,
  type LocationPlanResult,
  type LocationSearchScope,
  type LocationSourceCapabilities,
  type LocationSourcePlan,
  type LocationWorkplaceType,
  normalizeLocationCountryKey,
  normalizeLocationEvidence,
  normalizeLocationGeoScope,
  normalizeLocationIntent,
  normalizeLocationMatchStrictness,
  normalizeLocationSearchScope,
  normalizeLocationWorkplaceType,
  normalizeLocationWorkplaceTypes,
  planLocationSource,
  planLocationSources,
} from "../location-domain.js";

export type GeoScope = LocationGeoScope;
export type WorkplaceType = LocationWorkplaceType;
export type SourceLocationCapabilities = LocationSourceCapabilities;
export type SourceLocationPlan = LocationSourcePlan;
export type LocationMatchStrength = LocationMatchStrictness;
