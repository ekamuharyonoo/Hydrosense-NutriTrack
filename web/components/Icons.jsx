const Svg = ({ children, sw = 1.8 }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

/** Logo HydroSense: tetes air + sinyal + tunas (warna mengikuti currentColor). */
export const DropIcon = () => (
  <svg className="logo-mark" viewBox="0 0 100 112" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M50 6 C46 12 14 50 14 76 A36 36 0 0 0 86 76 C86 50 54 12 50 6 Z" strokeWidth={5} />
    <path d="M38 36 A17 17 0 0 1 62 36" strokeWidth={4.5} />
    <path d="M43 42 A10 10 0 0 1 57 42" strokeWidth={4.5} />
    <path d="M45.5 49 H54.5 M50 49 V54" strokeWidth={4} />
    <path d="M50 86 V104" strokeWidth={5} />
    <path d="M48 88 C48 73 41 63 26 60 C24 77 32 89 48 90 Z M45.2 84.1 L33.2 69.1 L30.8 70.9 L42.8 85.9 Z M52 88 C52 73 59 63 74 60 C76 77 68 89 52 90 Z M54.8 84.1 L66.8 69.1 L69.2 70.9 L57.2 85.9 Z" fill="currentColor" stroke="none" fillRule="evenodd" />
  </svg>
);
export const BellIcon = () => (
  <Svg><path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 12 6 8Z" /><path d="M9.5 17a2.5 2.5 0 0 0 5 0" /></Svg>
);
export const BoltIcon = ({ sw = 1.8 }) => (
  <Svg sw={sw}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></Svg>
);
export const HomeIcon = () => (
  <Svg><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9h12v-9" /></Svg>
);
export const ChartIcon = () => (
  <Svg><path d="M4 19V5m8 14V9m8 10V13" /></Svg>
);

export const SENSOR_ICONS = {
  ph: <Svg><path d="M9 3v9.5a4 4 0 1 0 6 0V3" /><path d="M9 3h6" /></Svg>,
  tds: <Svg><circle cx="12" cy="12" r="8.5" /><path d="M9 12h6M12 9v6" /></Svg>,
  temp: <Svg><path d="M12 14.5V4a2 2 0 1 0-4 0v10.5a4 4 0 1 0 4 0Z" /></Svg>,
};
