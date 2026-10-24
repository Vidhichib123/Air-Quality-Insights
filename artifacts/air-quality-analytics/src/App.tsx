import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useGetAirQualitySensorHistory, getGetAirQualitySensorHistoryQueryKey, useSearchAirQualityCity, getSearchAirQualityCityQueryKey } from '@workspace/api-client-react';
import type { AirQualityStation, AirQualityHistoryPoint } from '@workspace/api-client-react';
import { AlertCircle, ArrowDownRight, ArrowUpRight, Clock3, MapPin, Radio, RefreshCw, Search, Wind } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import './index.css';

const queryClient = new QueryClient();

function timeAgo(value?: string) {
  if (!value) return 'Time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Time unavailable';
  const mins = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function localTime(value?: string) {
  if (!value) return 'Local time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function validMeasurements(station?: AirQualityStation) {
  return (station?.measurements ?? []).filter((m) => Number.isFinite(m.value));
}

function getStationState(station: AirQualityStation) {
  const values = validMeasurements(station);
  if (!values.length) return 'No current readings';
  const oldest = Math.max(...values.map((m) => Date.now() - new Date(m.measuredAtUtc).getTime()).filter(Number.isFinite));
  if (oldest > 24 * 60 * 60 * 1000) return 'Latest reading over 24h';
  if (values.length < 2) return 'Partial readings';
  return 'Reporting';
}

function MeasurementChart({ points, unit, rangeLabel }: { points: AirQualityHistoryPoint[]; unit: string; rangeLabel: string }) {
  const values = points.map((point) => point.value);
  if (!points.length) {
    return <div className="chart-empty"><div className="empty-mark"><Wind size={20} /></div><strong>No measurements in this window</strong><span>There is no station history available for the selected period.</span></div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || Math.max(Math.abs(max) * .12, 1);
  const low = min - spread * .18;
  const high = max + spread * .18;
  const width = 760;
  const height = 236;
  const plot = points.map((p, index) => ({
    ...p,
    x: points.length === 1 ? width / 2 : (index / (points.length - 1)) * width,
    y: height - ((p.value - low) / (high - low)) * height,
  }));
  const line = plot.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  const last = plot[plot.length - 1];
  const labels = [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]];
  const yTicks = [high, (high + low) / 2, low];

  return (
    <div className="chart-wrap" data-testid="chart-history">
      <div className="chart-units">{yTicks.map((tick, i) => <span className="mono" key={i}>{tick.toFixed(tick >= 10 ? 0 : 1)} <small>{unit}</small></span>)}</div>
      <div className="chart-main">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${points.length} measured observations over ${rangeLabel}; latest ${last.value} ${unit}`}>
          <defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#397f7a" stopOpacity=".19" /><stop offset="100%" stopColor="#397f7a" stopOpacity="0" /></linearGradient></defs>
          {[0, 1, 2].map((i) => <line key={i} x1="0" x2={width} y1={(height / 2) * i} y2={(height / 2) * i} stroke="#d8d8cd" strokeDasharray="3 6" />)}
          {points.length > 1 && <path d={area} fill="url(#chartFill)" />}
          {points.length > 1 && <path d={line} fill="none" stroke="#397f7a" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
          {plot.map((p, i) => <circle key={`${p.measuredAtUtc}-${i}`} cx={p.x} cy={p.y} r={i === plot.length - 1 ? 5 : 2.5} fill={i === plot.length - 1 ? '#e1a26e' : '#397f7a'} stroke="#fbfaf5" strokeWidth="2" vectorEffect="non-scaling-stroke"><title>{p.value} {unit} · {localTime(p.measuredAtLocal)}</title></circle>)}
        </svg>
        <div className="chart-xlabels">{labels.map((point, i) => <span className="mono" key={`${point.measuredAtUtc}-${i}`}>{new Date(point.measuredAtLocal).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}</span>)}</div>
      </div>
    </div>
  );
}

function StationRow({ station, selected, onSelect }: { station: AirQualityStation; selected: boolean; onSelect: () => void }) {
  const readings = validMeasurements(station);
  return (
    <button type="button" className={`station-row ${selected ? 'is-selected' : ''}`} onClick={onSelect} data-testid={`button-station-${station.id}`} aria-pressed={selected}>
      <span className="station-indicator"><span /></span>
      <span className="station-copy">
        <strong>{station.name || 'Unnamed monitoring station'}</strong>
        <small>{station.locality || 'Locality not provided'} <span aria-hidden="true">·</span> {station.distanceKm.toFixed(1)} km</small>
      </span>
      <span className="station-meta"><b>{readings.length}</b><small>signals</small></span>
    </button>
  );
}

function Home() {
  const [queryText, setQueryText] = useState('');
  const [submittedCity, setSubmittedCity] = useState('');
  const [selectedStationId, setSelectedStationId] = useState<number | null>(null);
  const [selectedSensorId, setSelectedSensorId] = useState<number | null>(null);
  const [hours, setHours] = useState<24 | 168>(24);
  const cityQuery = useSearchAirQualityCity({ q: submittedCity }, {
    query: { enabled: submittedCity.length >= 2, queryKey: getSearchAirQualityCityQueryKey({ q: submittedCity }), staleTime: 60_000 },
  });
  const response = cityQuery.data;
  const stations = response?.stations ?? [];
  const selectedStation = stations.find((station) => station.id === selectedStationId) ?? stations[0];
  const measurements = useMemo(() => validMeasurements(selectedStation), [selectedStation]);

  useEffect(() => {
    if (selectedStation && !measurements.some((item) => item.sensorId === selectedSensorId)) {
      setSelectedSensorId(measurements[0]?.sensorId ?? null);
    }
  }, [selectedStation, selectedSensorId, measurements]);

  const activeMeasurement = measurements.find((item) => item.sensorId === selectedSensorId) ?? measurements[0];
  const historyQuery = useGetAirQualitySensorHistory(
    { sensorId: activeMeasurement?.sensorId ?? 0, hours },
    { query: { enabled: Boolean(activeMeasurement?.sensorId), queryKey: getGetAirQualitySensorHistoryQueryKey({ sensorId: activeMeasurement?.sensorId ?? 0, hours }), staleTime: 60_000 } },
  );
  const history = historyQuery.data;
  const sortedStations = useMemo(() => [...stations].sort((a, b) => a.distanceKm - b.distanceKm), [stations]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = queryText.trim();
    if (value.length >= 2) {
      setSelectedStationId(null);
      setSelectedSensorId(null);
      setSubmittedCity(value);
    }
  }

  const currentValue = activeMeasurement?.value;
  const readingAge = activeMeasurement ? timeAgo(activeMeasurement.measuredAtUtc) : '';
  const isStale = activeMeasurement ? Date.now() - new Date(activeMeasurement.measuredAtUtc).getTime() > 6 * 60 * 60 * 1000 : false;
  const currentError = cityQuery.error as { message?: string } | null;

  return (
    <main className="instrument-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-symbol"><Wind size={18} strokeWidth={1.8} /></span><span>ATMO<span className="brand-period">.</span></span></div>
        <div className="topbar-center"><span className="live-dot" /> OPEN AIR OBSERVATORY <span className="topbar-divider">/</span> FIELD VIEW</div>
        <div className="topbar-right"><span className="utc-note">PUBLIC MEASUREMENTS</span><span className="topbar-rule" /><span className="mono">AQ / 01</span></div>
      </header>

      <div className="page-frame">
        <section className="intro fade-up">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> AIR QUALITY, OBSERVED</div>
            <h1 className="display">Know the air<br className="desktop-break" /> around you.</h1>
            <p className="intro-copy">Measurements from nearby monitoring stations, with their source and timestamp in view.</p>
          </div>
          <div className="intro-stamp"><span>OPENAQ</span><span className="stamp-separator">·</span><span>STATION DATA</span><span className="stamp-separator">·</span><span>NO FORECASTS</span></div>
        </section>

        <section className="search-panel fade-up fade-delay-1" aria-label="Search by city">
          <form className="search-form" onSubmit={submitSearch}>
            <Search size={19} aria-hidden="true" />
            <label className="sr-only" htmlFor="city-search">Search a city</label>
            <input id="city-search" type="search" value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder="Search a city — for example, Seattle" minLength={2} maxLength={120} data-testid="input-city-search" />
            <button type="submit" className="search-button" disabled={queryText.trim().length < 2 || cityQuery.isFetching} data-testid="button-search-city">
              {cityQuery.isFetching ? <RefreshCw className="spin" size={15} /> : null} <span>{cityQuery.isFetching ? 'Locating' : 'Find stations'}</span><span aria-hidden="true">↗</span>
            </button>
          </form>
          <div className="search-foot"><span>Search by city or municipality</span><span>STATION OBSERVATIONS ONLY</span></div>
        </section>

        {!submittedCity && (
          <section className="welcome-panel fade-up fade-delay-2">
            <div className="welcome-grid">
              <div className="welcome-glyph"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="orbit-core"><Radio size={21} /></span></div>
              <div className="welcome-copy">
                <span className="section-kicker">A CLEARER READ ON YOUR NEIGHBORHOOD</span>
                <h2 className="display">Start with a place.</h2>
                <p>Choose a city to see nearby OpenAQ stations and their latest reported pollutant measurements. Every value is tied to a station and observation time.</p>
              </div>
              <div className="welcome-side"><span className="mono">01 — 02</span><span>Location<br />to observation</span></div>
            </div>
          </section>
        )}

        {submittedCity && (
          <>
            <section className="results-heading fade-up" aria-live="polite">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> MONITORING AREA</div>
                <h2 className="display">{response?.city.name ?? submittedCity}{response?.city.admin1 ? <span>, {response.city.admin1}</span> : null}</h2>
                <p>{response?.city.country ?? 'Searching available station records'}{response?.city.countryCode ? ` · ${response.city.countryCode}` : ''}</p>
              </div>
              <button type="button" className="quiet-button" onClick={() => cityQuery.refetch()} disabled={cityQuery.isFetching} data-testid="button-refresh-stations"><RefreshCw size={14} className={cityQuery.isFetching ? 'spin' : ''} /> Refresh stations</button>
            </section>

            {cityQuery.isLoading && <div className="loading-grid" aria-label="Loading station observations"><div className="skeleton station-skeleton" /><div className="skeleton detail-skeleton" /></div>}
            {cityQuery.isError && (
              <div className="state-panel state-error" role="alert" data-testid="status-search-error"><span className="state-icon"><AlertCircle size={18} /></span><div><strong>Station search could not be completed.</strong><p>{currentError?.message || 'Check your connection and try searching again.'}</p></div><button type="button" className="text-action" onClick={() => cityQuery.refetch()}>Try again</button></div>
            )}
            {!cityQuery.isLoading && !cityQuery.isError && response && stations.length === 0 && (
              <div className="state-panel" data-testid="status-no-stations"><span className="state-icon"><MapPin size={18} /></span><div><strong>No nearby stations found.</strong><p>There are no station records available for this place right now. Try a nearby city or a broader search.</p></div></div>
            )}
            {!cityQuery.isLoading && !cityQuery.isError && response && stations.length > 0 && (
              <div className="workspace-grid fade-up fade-delay-1">
                <aside className="station-panel">
                  <div className="panel-heading">
                    <div><span className="section-kicker">NEARBY NETWORK</span><h3>Monitoring stations</h3></div>
                    <span className="count-pill mono">{stations.length.toString().padStart(2, '0')}</span>
                  </div>
                  <div className="station-list">
                    {sortedStations.map((station) => <StationRow key={station.id} station={station} selected={selectedStation?.id === station.id} onSelect={() => { setSelectedStationId(station.id); setSelectedSensorId(null); }} />)}
                  </div>
                  <div className="station-foot"><span className="source-mark" /> Sorted by distance <span className="foot-dot">·</span> Source: OpenAQ</div>
                </aside>

                {selectedStation && (
                  <section className="detail-column" aria-label="Selected station observations">
                    <div className="detail-card">
                      <div className="station-title-row">
                        <div className="station-title-icon"><Radio size={17} /></div>
                        <div className="station-title-copy">
                          <span className="section-kicker">SELECTED STATION <span className="id-mark">/ {selectedStation.id}</span></span>
                          <h3>{selectedStation.name || 'Unnamed monitoring station'}</h3>
                          <p><MapPin size={13} /> {selectedStation.locality || response.city.name} <span>·</span> {selectedStation.distanceKm.toFixed(1)} km away</p>
                        </div>
                        <div className={`reporting-badge ${getStationState(selectedStation) !== 'Reporting' ? 'badge-muted' : ''}`}><span /> {getStationState(selectedStation)}</div>
                      </div>

                      {!measurements.length ? (
                        <div className="no-reading"><span className="no-reading-icon"><AlertCircle size={17} /></span><div><strong>No current measurements reported</strong><p>This station is listed, but no pollutant values are available in the latest response.</p></div></div>
                      ) : (
                        <>
                          <div className="reading-strip">
                            <div className="reading-main">
                              <span className="section-kicker">LATEST OBSERVATION</span>
                              <div className="value-line"><strong className="mono">{currentValue?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong><span>{activeMeasurement?.unit}</span></div>
                              <div className="reading-name">{activeMeasurement?.displayName ?? activeMeasurement?.parameter}</div>
                            </div>
                            <div className="reading-context">
                              <div className="context-item"><Clock3 size={14} /><div><span>Observed</span><strong>{readingAge}</strong></div></div>
                              <div className="context-item"><MapPin size={14} /><div><span>Local timestamp</span><strong>{activeMeasurement?.measuredAtLocal ? localTime(activeMeasurement.measuredAtLocal) : 'Not provided'}</strong></div></div>
                            </div>
                          </div>
                          {isStale && <div className="stale-note" role="status"><Clock3 size={13} /> This observation is more than 6 hours old. The value remains the station's latest reported measurement.</div>}
                          {measurements.length > 1 && (
                            <div className="pollutant-row">
                              <span className="section-kicker">AVAILABLE PARAMETERS</span>
                              <div className="parameter-tabs" role="group" aria-label="Select pollutant">
                                {measurements.map((measurement) => <button type="button" key={measurement.sensorId} className={`parameter-tab ${measurement.sensorId === activeMeasurement?.sensorId ? 'active' : ''}`} onClick={() => setSelectedSensorId(measurement.sensorId)} aria-pressed={measurement.sensorId === activeMeasurement?.sensorId} data-testid={`button-parameter-${measurement.parameter}-${measurement.sensorId}`}><span>{measurement.displayName || measurement.parameter}</span><small>{measurement.value.toLocaleString(undefined, { maximumFractionDigits: 2 })} {measurement.unit}</small></button>)}
                              </div>
                            </div>
                          )}
                          <div className="source-row"><span className="source-badge">OPENAQ</span><span>Reported by this monitoring station</span><span className="source-time mono">{activeMeasurement?.measuredAtUtc ? new Date(activeMeasurement.measuredAtUtc).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'UTC time unavailable'}</span></div>
                        </>
                      )}
                    </div>

                    <div className="history-card">
                      <div className="history-heading">
                        <div><span className="section-kicker">MEASURED HISTORY</span><h3 className="display">{activeMeasurement?.displayName || activeMeasurement?.parameter || 'Pollutant'} <span>over time</span></h3></div>
                        <div className="range-control" role="group" aria-label="History period">
                          <button type="button" onClick={() => setHours(24)} className={hours === 24 ? 'selected' : ''} aria-pressed={hours === 24} data-testid="button-range-24h">24 hours</button>
                          <button type="button" onClick={() => setHours(168)} className={hours === 168 ? 'selected' : ''} aria-pressed={hours === 168} data-testid="button-range-7d">7 days</button>
                        </div>
                      </div>
                      <div className="history-subline"><span className="history-legend" /><span>{activeMeasurement?.unit} · {hours === 24 ? 'past 24 hours' : 'past 7 days'}</span><span className="subline-count mono">{history?.measurements?.length ?? 0} observations</span></div>

                      {historyQuery.isLoading && <div className="chart-loading"><div className="chart-skeleton" /><span>Loading station history…</span></div>}
                      {historyQuery.isError && <div className="history-error" role="alert"><AlertCircle size={15} /><span>History could not be loaded.</span><button type="button" onClick={() => historyQuery.refetch()}>Retry</button></div>}
                      {!historyQuery.isLoading && !historyQuery.isError && history && (
                        <>
                          {history.measurements.length > 0 && <div className="history-stats">
                            <div><span>Latest</span><strong className="mono">{history.measurements[history.measurements.length - 1].value.toLocaleString(undefined, { maximumFractionDigits: 2 })}<small> {history.unit}</small></strong></div>
                            <div><span>Window high</span><strong className="mono">{Math.max(...history.measurements.map((point) => point.value)).toLocaleString(undefined, { maximumFractionDigits: 2 })}<small> {history.unit}</small></strong><ArrowUpRight size={13} /></div>
                            <div><span>Window low</span><strong className="mono">{Math.min(...history.measurements.map((point) => point.value)).toLocaleString(undefined, { maximumFractionDigits: 2 })}<small> {history.unit}</small></strong><ArrowDownRight size={13} /></div>
                          </div>}
                          <MeasurementChart points={history.measurements} unit={history.unit} rangeLabel={hours === 24 ? '24 hours' : '7 days'} />
                          <div className="history-foot"><span>OpenAQ station measurements</span><span>{history.measurements.length ? `Most recent: ${localTime(history.measurements[history.measurements.length - 1].measuredAtLocal)}` : 'No timestamp available'}</span></div>
                        </>
                      )}
                      {historyQuery.isFetching && !historyQuery.isLoading && <div className="refresh-indicator"><RefreshCw size={12} className="spin" /> Updating history</div>}
                    </div>
                  </section>
                )}
              </div>
            )}
            {response && <div className="response-foot"><span>Fetched {timeAgo(response.fetchedAtUtc)}</span><span className="foot-dot">·</span><span>Station values are individual observations, not a combined air-quality index.</span></div>}
          </>
        )}

        <footer className="app-footer"><span>ATMO <i>FIELD NOTES</i></span><span>Clarity through observation.</span><span className="mono">OPENAQ · 01</span></footer>
      </div>
    </main>
  );
}

function Router() {
  return <RouteErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RouteErrorBoundary>;
}

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
