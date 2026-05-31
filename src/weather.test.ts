// weather.ts の純粋ロジック (整形/単位/トレンド/sun)。geolocation/fetch はブラウザ依存で除外。
// 実行: bun test src/weather.test.ts
import { expect, test } from 'bun:test'
import {
  buildWeatherDoc,
  DEFAULT_WEATHER_OPTIONS,
  formatDayLength,
  formatSunTime,
  hpaToInHg,
  openMeteoUrl,
  type PrecipSlot,
  pop1hMax,
  precip1hSum,
  pressureTrend,
  rainNowcastLabel,
  readWeatherOptions,
  WEATHER_GROUP_ID,
  type WeatherOptions,
  type WeatherReading,
  weatherCodeText,
  windDir8,
} from './weather'

const baseReading: WeatherReading = { temp: 12.4, code: 2, wind: 18.6 }

test('weatherCodeText: WMO code を短い ASCII ラベルへ', () => {
  expect(weatherCodeText(0)).toBe('Clear')
  expect(weatherCodeText(1)).toBe('Clear')
  expect(weatherCodeText(2)).toBe('Cloudy')
  expect(weatherCodeText(3)).toBe('Overcast')
  expect(weatherCodeText(45)).toBe('Fog')
  expect(weatherCodeText(48)).toBe('Fog')
  expect(weatherCodeText(55)).toBe('Drizzle')
  expect(weatherCodeText(63)).toBe('Rain')
  expect(weatherCodeText(75)).toBe('Snow')
  expect(weatherCodeText(86)).toBe('Snow')
  expect(weatherCodeText(81)).toBe('Showers')
  expect(weatherCodeText(95)).toBe('Storm')
  expect(weatherCodeText(99)).toBe('Storm')
  expect(weatherCodeText(123)).toBe('Wx') // 未知コード
})

test('buildWeatherDoc: 既定 reading は temp/cond/wind のみ (拡張/sun は欠落で push しない)', () => {
  const doc = buildWeatherDoc(baseReading, DEFAULT_WEATHER_OPTIONS, 1000)
  expect(doc.groups).toHaveLength(1)
  const g = doc.groups[0]
  expect(g.id).toBe(WEATHER_GROUP_ID)
  expect(g.label).toBe('Weather')
  const byId = new Map(g.segments.map((s) => [s.id, s]))
  expect(byId.get('temp')?.value).toBe('12C') // ASCII のみ (° を避ける)
  expect(byId.get('cond')?.value).toBe('Cloudy')
  expect(byId.get('wind')?.value).toBe('19km/h')
  expect(byId.get('temp')?.defaultEnabled).toBe(true)
  expect(byId.get('wind')?.defaultEnabled).toBe(false) // wind は既定 OFF
  // 拡張/sun フィールドが無ければ segment は出ない
  expect(byId.has('feels')).toBe(false)
  expect(byId.has('sunrise')).toBe(false)
})

test('buildWeatherDoc: 拡張 segment は data がある分だけ既定 OFF で push される (#40)', () => {
  const reading: WeatherReading = {
    ...baseReading,
    feels: 27.3,
    humidity: 64,
    windDeg: 45,
    uv: 7,
    pressureHpa: 1013,
    pressureDelta3h: -3.5,
  }
  const g = buildWeatherDoc(reading, DEFAULT_WEATHER_OPTIONS, 1).groups[0]
  const byId = new Map(g.segments.map((s) => [s.id, s]))
  expect(byId.get('feels')?.value).toBe('27C')
  expect(byId.get('humid')?.value).toBe('64%')
  expect(byId.get('wdir')?.value).toBe('NE') // 45° = NE (text 既定)
  expect(byId.get('uv')?.value).toBe('7')
  expect(byId.get('pres')?.value).toBe('1013hPa')
  expect(byId.get('ptrend')?.value).toBe('Fall fast') // -3.5 <= -3 (normal)
  for (const id of ['feels', 'humid', 'wdir', 'uv', 'pres', 'ptrend']) {
    expect(byId.get(id)?.defaultEnabled).toBe(false)
  }
})

test('buildWeatherDoc: F / inHg / arrow / 12h オプションが値へ反映される', () => {
  const opts: WeatherOptions = {
    tempUnit: 'F',
    windUnit: 'mph',
    windDir: 'arrow',
    presUnit: 'inHg',
    stormSensitivity: 'normal',
    sunFormat: '12h',
  }
  const reading: WeatherReading = {
    temp: 81,
    code: 0,
    wind: 12,
    feels: 84,
    windDeg: 90,
    pressureHpa: 1015.2,
    sunriseIso: '2026-05-31T04:25',
    sunsetIso: '2026-05-31T19:01',
  }
  const byId = new Map(buildWeatherDoc(reading, opts, 1).groups[0].segments.map((s) => [s.id, s]))
  expect(byId.get('temp')?.value).toBe('81F')
  expect(byId.get('feels')?.value).toBe('84F')
  expect(byId.get('wind')?.value).toBe('12mph')
  expect(byId.get('wdir')?.value).toBe('→') // 90° = E = arrow
  expect(byId.get('pres')?.value).toBe('29.98inHg') // 1015.2 hPa
  expect(byId.get('sunrise')?.value).toBe('4:25a')
  expect(byId.get('sunset')?.value).toBe('7:01p')
  expect(byId.get('daylength')?.value).toBe('14h36m')
})

test('buildWeatherDoc: state/message を載せられる (stale/error 表示用)', () => {
  const doc = buildWeatherDoc(
    baseReading,
    DEFAULT_WEATHER_OPTIONS,
    1,
    'stale',
    'using cached weather',
  )
  expect(doc.groups[0].state).toBe('stale')
  expect(doc.groups[0].message).toBe('using cached weather')
})

test('windDir8: 度を 8 方位へ量子化 (負値/360 超も正規化)', () => {
  expect(windDir8(0)).toBe('N')
  expect(windDir8(45)).toBe('NE')
  expect(windDir8(90)).toBe('E')
  expect(windDir8(180)).toBe('S')
  expect(windDir8(270)).toBe('W')
  expect(windDir8(359)).toBe('N') // 360 へ丸まり N
  expect(windDir8(-45)).toBe('NW') // 負値も正規化
  expect(windDir8(720 + 135)).toBe('SE')
})

test('pressureTrend: 3h 変化量と感度でラベルを量子化', () => {
  expect(pressureTrend(-5, 'normal')).toBe('Fall fast')
  expect(pressureTrend(-2, 'normal')).toBe('Falling')
  expect(pressureTrend(0, 'normal')).toBe('Steady')
  expect(pressureTrend(2, 'normal')).toBe('Rising')
  expect(pressureTrend(5, 'normal')).toBe('Rise fast')
  // 感度 high はしきい値 2hPa: -2 で急降下、low は 4hPa なので -2 は Falling 止まり
  expect(pressureTrend(-2, 'high')).toBe('Fall fast')
  expect(pressureTrend(-2, 'low')).toBe('Falling')
})

test('hpaToInHg: 標準気圧 1013.25hPa ≒ 29.92inHg', () => {
  expect(hpaToInHg(1013.25)).toBeCloseTo(29.92, 2)
})

test('formatSunTime: 24h/12h を端末 TZ 非依存で整形', () => {
  expect(formatSunTime('2026-05-31T04:25', false)).toBe('04:25')
  expect(formatSunTime('2026-05-31T19:01', false)).toBe('19:01')
  expect(formatSunTime('2026-05-31T04:25', true)).toBe('4:25a')
  expect(formatSunTime('2026-05-31T19:01', true)).toBe('7:01p')
  expect(formatSunTime('2026-05-31T00:09', true)).toBe('12:09a') // 0 時 = 12a
  expect(formatSunTime('2026-05-31T12:00', true)).toBe('12:00p') // 正午 = 12p
  expect(formatSunTime('bad', false)).toBe('n/a')
})

test('formatDayLength: 昼の長さ HhMMm (日跨ぎは 24h 加算)', () => {
  expect(formatDayLength('2026-05-31T04:25', '2026-05-31T19:01')).toBe('14h36m')
  expect(formatDayLength('2026-12-21T07:00', '2026-12-21T16:05')).toBe('9h05m')
  expect(formatDayLength('2026-06-21T03:00', '2026-06-22T01:00')).toBe('22h00m') // set < rise → +24h
})

test('readWeatherOptions: 未設定/不正値は既定へフォールバック', () => {
  expect(readWeatherOptions(undefined)).toEqual(DEFAULT_WEATHER_OPTIONS)
  expect(readWeatherOptions({ tempUnit: 'F', sunFormat: '12h' })).toMatchObject({
    tempUnit: 'F',
    sunFormat: '12h',
    windUnit: 'kmh', // 未設定は既定
  })
  expect(readWeatherOptions({ tempUnit: 'K', windUnit: 999 })).toMatchObject({
    tempUnit: 'C', // 不正値は既定
    windUnit: 'kmh',
  })
})

test('openMeteoUrl: host 固定 + 丸め座標 + daily/hourly/minutely + 単位パラメータを含む', () => {
  const u = new URL(openMeteoUrl(35.68, 139.61))
  expect(u.host).toBe('api.open-meteo.com')
  expect(u.searchParams.get('latitude')).toBe('35.68')
  expect(u.searchParams.get('longitude')).toBe('139.61')
  expect(u.searchParams.get('daily')).toBe('sunrise,sunset')
  expect(u.searchParams.get('hourly')).toContain('surface_pressure') // 気圧トレンド
  expect(u.searchParams.get('hourly')).toContain('precipitation') // 降水 hourly フォールバック
  expect(u.searchParams.get('minutely_15')).toBe('precipitation,precipitation_probability') // #39
  expect(u.searchParams.get('temperature_unit')).toBe('celsius') // 既定 C
  expect(u.searchParams.get('current')).toContain('apparent_temperature')
})

test('openMeteoUrl: 単位オプションがクエリへ反映される (F/mph)', () => {
  const u = new URL(
    openMeteoUrl(35, 139, { ...DEFAULT_WEATHER_OPTIONS, tempUnit: 'F', windUnit: 'mph' }),
  )
  expect(u.searchParams.get('temperature_unit')).toBe('fahrenheit')
  expect(u.searchParams.get('wind_speed_unit')).toBe('mph')
})

// ── #39 降水ナウキャスト ──
test('rainNowcastLabel: 乾燥中は次の降雨を ~Nm(5分丸め)で出す', () => {
  const slots: PrecipSlot[] = [
    { min: 0, precip: 0, prob: 10 },
    { min: 15, precip: 0, prob: 20 },
    { min: 30, precip: 0.5, prob: 80 }, // ここで降り出す
    { min: 45, precip: 1.2, prob: 90 },
  ]
  expect(rainNowcastLabel(slots, 0.1, 'minutely')).toBe('Rain ~30m')
})

test('rainNowcastLabel: 18分後の降雨は ~20m に 5 分丸め', () => {
  const slots: PrecipSlot[] = [
    { min: 3, precip: 0, prob: 0 },
    { min: 18, precip: 0.4, prob: 70 },
  ]
  expect(rainNowcastLabel(slots, 0.1, 'minutely')).toBe('Rain ~20m')
})

test('rainNowcastLabel: 降水中は止む時刻を Stops ~Nm で出す', () => {
  const slots: PrecipSlot[] = [
    { min: 0, precip: 0.8, prob: 90 }, // 降水中
    { min: 15, precip: 0.3, prob: 60 },
    { min: 30, precip: 0, prob: 20 }, // ここで止む
  ]
  expect(rainNowcastLabel(slots, 0.1, 'minutely')).toBe('Stops ~30m')
})

test('rainNowcastLabel: 当面降水なしは Dry、降り続くなら Rain', () => {
  const dry: PrecipSlot[] = [
    { min: 0, precip: 0, prob: 5 },
    { min: 60, precip: 0, prob: 10 },
  ]
  expect(rainNowcastLabel(dry, 0.1, 'minutely')).toBe('Dry')
  const ongoing: PrecipSlot[] = [
    { min: 0, precip: 1.0, prob: 95 },
    { min: 60, precip: 0.9, prob: 90 }, // 窓内ずっと降水
  ]
  expect(rainNowcastLabel(ongoing, 0.1, 'minutely')).toBe('Rain')
})

test('rainNowcastLabel: hourly 粒度は ~Nh、空スロットは undefined', () => {
  const slots: PrecipSlot[] = [
    { min: 0, precip: 0, prob: 0 },
    { min: 120, precip: 0.5, prob: 60 },
  ]
  expect(rainNowcastLabel(slots, 0.1, 'hourly')).toBe('Rain ~2h')
  expect(rainNowcastLabel([], 0.1, 'minutely')).toBeUndefined()
})

test('rainNowcastLabel: しきい値を上げると小雨が降水扱いから外れる', () => {
  const slots: PrecipSlot[] = [
    { min: 0, precip: 0, prob: 10 },
    { min: 30, precip: 0.3, prob: 50 }, // 小雨
  ]
  expect(rainNowcastLabel(slots, 0.1, 'minutely')).toBe('Rain ~30m') // 0.1mm では降水
  expect(rainNowcastLabel(slots, 1.0, 'minutely')).toBe('Dry') // 1.0mm では非降水
})

test('pop1hMax / precip1hSum: 次 1 時間の窓 [0,60) で集計', () => {
  const slots: PrecipSlot[] = [
    { min: -15, precip: 5, prob: 99 }, // 過去は除外
    { min: 0, precip: 0.2, prob: 40 },
    { min: 15, precip: 0.3, prob: 70 },
    { min: 45, precip: 0.5, prob: 60 },
    { min: 60, precip: 9, prob: 100 }, // 60 は窓外(< 60)
  ]
  expect(pop1hMax(slots)).toBe(70)
  expect(precip1hSum(slots)).toBeCloseTo(1.0, 5)
  expect(pop1hMax([])).toBeUndefined()
})

test('buildWeatherDoc: rainin は既定 ON、pop1h/precip1h は既定 OFF', () => {
  const reading: WeatherReading = {
    ...baseReading,
    rainLabel: 'Rain ~20m',
    pop1h: 60,
    precip1h: 1.2,
  }
  const byId = new Map(
    buildWeatherDoc(reading, DEFAULT_WEATHER_OPTIONS, 1).groups[0].segments.map((s) => [s.id, s]),
  )
  expect(byId.get('rainin')?.value).toBe('Rain ~20m')
  expect(byId.get('rainin')?.defaultEnabled).toBe(true)
  expect(byId.get('pop1h')?.value).toBe('60%')
  expect(byId.get('pop1h')?.defaultEnabled).toBe(false)
  expect(byId.get('precip1h')?.value).toBe('1.2mm')
})

test('buildWeatherDoc: rainMode で rainin の表示が切替わる', () => {
  const reading: WeatherReading = {
    ...baseReading,
    rainLabel: 'Dry',
    pop1h: 60,
    precip1h: 1.2,
  }
  const v = (mode: WeatherOptions['rainMode']): string | undefined =>
    new Map(
      buildWeatherDoc(
        { ...reading },
        { ...DEFAULT_WEATHER_OPTIONS, rainMode: mode },
        1,
      ).groups[0].segments.map((s) => [s.id, s.value]),
    ).get('rainin')
  expect(v('nextrain')).toBe('Dry')
  expect(v('1hchance')).toBe('60%')
  expect(v('recent')).toBe('1.2mm')
})

test('buildWeatherDoc: 降水データが無ければ rainin/pop1h/precip1h は出さない', () => {
  const byId = new Map(
    buildWeatherDoc(baseReading, DEFAULT_WEATHER_OPTIONS, 1).groups[0].segments.map((s) => [
      s.id,
      s,
    ]),
  )
  expect(byId.has('rainin')).toBe(false)
  expect(byId.has('pop1h')).toBe(false)
})

test('readWeatherOptions: 降水 option の既定とclamp', () => {
  expect(readWeatherOptions(undefined)).toMatchObject({
    rainMode: 'nextrain',
    rainThreshold: 0.1,
    rainGranularity: 'auto',
  })
  expect(readWeatherOptions({ rainMode: '1hchance', rainThreshold: 1.5 })).toMatchObject({
    rainMode: '1hchance',
    rainThreshold: 1.5,
  })
  expect(readWeatherOptions({ rainThreshold: 99 }).rainThreshold).toBe(5) // max clamp
  expect(readWeatherOptions({ rainThreshold: -3 }).rainThreshold).toBe(0) // min clamp
  expect(readWeatherOptions({ rainThreshold: 'x' }).rainThreshold).toBe(0.1) // 不正値は既定
  expect(readWeatherOptions({ rainMode: 'bogus' }).rainMode).toBe('nextrain')
})
