export interface DeviceCoordinates {
  latitude: number;
  longitude: number;
}

export interface ReverseGeocodedPlace {
  city?: string | null;
  subregion?: string | null;
  region?: string | null;
  country?: string | null;
}

export interface DeviceLocationUpdate extends DeviceCoordinates {
  city: string;
  country: string;
}

/**
 * Converts the OS reverse-geocode result into the only location payload the
 * profile API accepts. No typed place name is accepted by this boundary.
 */
export function deviceLocationFromReverseGeocode(
  place: ReverseGeocodedPlace | undefined,
  coordinates: DeviceCoordinates
): DeviceLocationUpdate | null {
  const city = (place?.city ?? place?.subregion ?? place?.region ?? '').trim();
  const country = (place?.country ?? '').trim();
  const coordinatesValid = Number.isFinite(coordinates.latitude)
    && Number.isFinite(coordinates.longitude)
    && coordinates.latitude >= -90
    && coordinates.latitude <= 90
    && coordinates.longitude >= -180
    && coordinates.longitude <= 180;

  if (!coordinatesValid || city.length < 2 || city.length > 100 || country.length < 2 || country.length > 100) {
    return null;
  }

  return { city, country, ...coordinates };
}
