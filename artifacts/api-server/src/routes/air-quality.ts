import { Router, type IRouter } from "express";
import {
  GetAirQualitySensorHistoryQueryParams,
  GetAirQualitySensorHistoryResponse,
  SearchAirQualityCityQueryParams,
  SearchAirQualityCityResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const OPENAQ_API = "https://api.openaq.org/v3";
const GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STATIONS_TO_QUERY = 8;

type JsonRecord = Record<string, unknown>;

type CityCoordinates = {
  name: string;
  admin1: string | null;
  country: string;
  countryCode: string | null;
  latitude: number;
  longitude: number;
};

type SensorMetadata = {
  id: number;
  parameter: string;
  displayName: string;
  unit: string;
};

type StationCandidate = {
  id: number;
  name: string;
  locality: string | null;
  latitude: number;
  longitude: number;
  distanceKm: number;
  sensors: Map<number, SensorMetadata>;
};

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function dateTimePair(value: unknown): { utc: string; local: string } | null {
  const record = asRecord(value);
  const utc = record?.utc;
  const local = record?.local;
  if (!isDateTime(utc)) {
    return null;
  }
  return { utc, local: isDateTime(local) ? local : utc };
}

async function fetchJson(
  url: URL,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new UpstreamError(response.status, "An upstream request failed.");
  }
  return response.json() as Promise<unknown>;
}

async function fetchOpenAq(path: string, params?: URLSearchParams): Promise<unknown> {
  const apiKey = process.env.OPENAQ_API_KEY;
  if (!apiKey) {
    throw new UpstreamError(503, "The OpenAQ API key is not configured.");
  }

  const url = new URL(`${OPENAQ_API}${path}`);
  if (params) {
    url.search = params.toString();
  }
  return fetchJson(url, { "X-API-Key": apiKey });
}

async function geocodeCity(query: string): Promise<CityCoordinates | null> {
  const url = new URL(GEOCODING_API);
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const payload = asRecord(await fetchJson(url));
  const result = asRecord(asArray(payload?.results)[0]);
  const latitude = finiteNumber(result?.latitude);
  const longitude = finiteNumber(result?.longitude);
  if (!result || latitude === null || longitude === null) {
    return null;
  }

  return {
    name: stringValue(result.name, query),
    admin1: nullableString(result.admin1),
    country: stringValue(result.country),
    countryCode: nullableString(result.country_code),
    latitude,
    longitude,
  };
}

function distanceInKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseSensorMetadata(value: unknown): SensorMetadata | null {
  const sensor = asRecord(value);
  const parameter = asRecord(sensor?.parameter);
  const id = finiteNumber(sensor?.id);
  const parameterName = stringValue(parameter?.name);
  if (id === null || !parameterName) {
    return null;
  }

  return {
    id,
    parameter: parameterName,
    displayName: stringValue(parameter?.displayName, parameterName),
    unit: stringValue(parameter?.units, "unit unavailable"),
  };
}

function parseStationCandidate(
  value: unknown,
  city: CityCoordinates,
): StationCandidate | null {
  const station = asRecord(value);
  const id = finiteNumber(station?.id);
  const coordinates = asRecord(station?.coordinates);
  const latitude = finiteNumber(coordinates?.latitude);
  const longitude = finiteNumber(coordinates?.longitude);
  if (id === null || latitude === null || longitude === null) {
    return null;
  }

  const sensors = new Map<number, SensorMetadata>();
  for (const sensorValue of asArray(station?.sensors)) {
    const sensor = parseSensorMetadata(sensorValue);
    if (sensor) {
      sensors.set(sensor.id, sensor);
    }
  }

  return {
    id,
    name: stringValue(station?.name, "Unnamed monitoring station"),
    locality: nullableString(station?.locality),
    latitude,
    longitude,
    distanceKm: distanceInKm(
      city.latitude,
      city.longitude,
      latitude,
      longitude,
    ),
    sensors,
  };
}

function parseLatestMeasurement(
  value: unknown,
  station: StationCandidate,
): {
  sensorId: number;
  parameter: string;
  displayName: string;
  unit: string;
  value: number;
  measuredAtUtc: string;
  measuredAtLocal: string;
} | null {
  const measurement = asRecord(value);
  const sensorId = finiteNumber(measurement?.sensorsId);
  const reading = finiteNumber(measurement?.value);
  const datetime = dateTimePair(measurement?.datetime);
  const sensor = sensorId === null ? undefined : station.sensors.get(sensorId);
  if (sensorId === null || reading === null || !datetime || !sensor) {
    return null;
  }

  return {
    sensorId,
    parameter: sensor.parameter,
    displayName: sensor.displayName,
    unit: sensor.unit,
    value: reading,
    measuredAtUtc: datetime.utc,
    measuredAtLocal: datetime.local,
  };
}

async function latestForStation(station: StationCandidate) {
  const payload = asRecord(
    await fetchOpenAq(`/locations/${station.id}/latest`, new URLSearchParams({ limit: "100" })),
  );
  const measurements = asArray(payload?.results)
    .map((item) => parseLatestMeasurement(item, station))
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.parameter.localeCompare(b.parameter));

  return {
    id: station.id,
    name: station.name,
    locality: station.locality,
    latitude: station.latitude,
    longitude: station.longitude,
    distanceKm: Math.round(station.distanceKm * 10) / 10,
    measurements,
  };
}

function sensorMetadataFrom(value: unknown): Omit<SensorMetadata, "id"> | null {
  const sensor = asRecord(value);
  const parameter = asRecord(sensor?.parameter);
  const parameterName = stringValue(parameter?.name);
  if (!parameterName) {
    return null;
  }
  return {
    parameter: parameterName,
    displayName: stringValue(parameter?.displayName, parameterName),
    unit: stringValue(parameter?.units, "unit unavailable"),
  };
}

router.get("/air-quality/city", async (req, res): Promise<void> => {
  const query = SearchAirQualityCityQueryParams.safeParse(req.query);
  if (!query.success || typeof query.data.q !== "string" || !query.data.q.trim()) {
    res.status(400).json({ error: "Enter a city name with at least two characters." });
    return;
  }

  try {
    const city = await geocodeCity(query.data.q.trim());
    if (!city) {
      res.status(404).json({ error: "No matching city was found." });
      return;
    }

    const locationsPayload = asRecord(
      await fetchOpenAq(
        "/locations",
        new URLSearchParams({
          coordinates: `${city.latitude},${city.longitude}`,
          radius: "25000",
          limit: "100",
        }),
      ),
    );
    const candidates = asArray(locationsPayload?.results)
      .map((item) => parseStationCandidate(item, city))
      .filter((item): item is StationCandidate => item !== null && item.sensors.size > 0)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_STATIONS_TO_QUERY);

    const stations = (await Promise.all(candidates.map(latestForStation)))
      .filter((station) => station.measurements.length > 0)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const response = SearchAirQualityCityResponse.parse({
      city,
      fetchedAtUtc: new Date().toISOString(),
      stations,
    });
    res.json(response);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    req.log.error(
      { status, error: error instanceof Error ? error.message : "Unknown error" },
      "Air-quality city lookup failed",
    );
    const message =
      status === 401 || status === 403
        ? "OpenAQ rejected the server API key."
        : status === 429
          ? "OpenAQ is rate-limiting requests. Please try again shortly."
          : "Live air-quality data is temporarily unavailable.";
    res.status(502).json({ error: message });
  }
});

router.get("/air-quality/sensor-history", async (req, res): Promise<void> => {
  const query = GetAirQualitySensorHistoryQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Choose a valid sensor and time range." });
    return;
  }

  const { sensorId, hours } = query.data as typeof query.data & {
    sensorId: number;
    hours: number;
  };
  const now = new Date();
  const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const params = new URLSearchParams({
    datetime_from: start.toISOString(),
    datetime_to: now.toISOString(),
    limit: "500",
  });

  try {
    const [sensorPayload, measurementsPayload] = await Promise.all([
      fetchOpenAq(`/sensors/${sensorId}`),
      fetchOpenAq(`/sensors/${sensorId}/measurements`, params),
    ]);
    const sensorRoot = asRecord(sensorPayload);
    const sensorRecord =
      asRecord(asArray(sensorRoot?.results)[0]) ?? sensorRoot;
    const sensorInfo = sensorMetadataFrom(sensorRecord);
    const measurementRows = asArray(asRecord(measurementsPayload)?.results);
    const firstMeasurement = asRecord(measurementRows[0]);
    const fallbackInfo = sensorMetadataFrom(firstMeasurement);
    const metadata = sensorInfo ?? fallbackInfo;
    if (!metadata) {
      res.status(404).json({ error: "Sensor details were not found." });
      return;
    }

    const measurements = measurementRows
      .map((value) => {
        const measurement = asRecord(value);
        const period = asRecord(measurement?.period);
        const datetime =
          dateTimePair(period?.datetimeTo) ??
          dateTimePair(period?.datetimeFrom) ??
          dateTimePair(measurement?.datetime);
        const reading = finiteNumber(measurement?.value);
        if (reading === null || !datetime) {
          return null;
        }
        return {
          value: reading,
          measuredAtUtc: datetime.utc,
          measuredAtLocal: datetime.local,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort(
        (a, b) =>
          new Date(a.measuredAtUtc).getTime() -
          new Date(b.measuredAtUtc).getTime(),
      );

    const response = GetAirQualitySensorHistoryResponse.parse({
      sensorId,
      ...metadata,
      hours,
      measurements,
    });
    res.json(response);
  } catch (error) {
    const status = error instanceof UpstreamError ? error.status : 502;
    req.log.error(
      { sensorId, status, error: error instanceof Error ? error.message : "Unknown error" },
      "Air-quality sensor history lookup failed",
    );
    const message =
      status === 401 || status === 403
        ? "OpenAQ rejected the server API key."
        : status === 429
          ? "OpenAQ is rate-limiting requests. Please try again shortly."
          : "Sensor history is temporarily unavailable.";
    res.status(502).json({ error: message });
  }
});

export default router;
