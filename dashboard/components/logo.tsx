/** The GodsEye mark: an eye outline with a purple iris, in a white dot. */
export function Logo({ size = 44 }: { size?: number }) {
  return (
    <span className="dot bg-white" style={{ width: size, height: size }} aria-hidden>
      <svg width={size / 2} height={size / 2} viewBox="0 0 24 24" fill="none" stroke="#1E1E21" strokeWidth="1.8">
        <path d="M2 12c2.8-5 6.1-7.5 10-7.5S19.2 7 22 12c-2.8 5-6.1 7.5-10 7.5S4.8 17 2 12z" />
        <circle cx="12" cy="12" r="3.2" fill="#8B63FF" stroke="none" />
      </svg>
    </span>
  );
}
