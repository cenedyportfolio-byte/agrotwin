"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/api";
import { Brand, CHECK, Corners, IC, Icon, ThemeScript, ThemeSwitch, useSiteTheme } from "./parts";
import l from "./landing.module.css";
import s from "./signin.module.css";

/* The sign-in page (/login), from the Claude Design handoff "AgroTwin Sign In". */

const EYE = "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const EYE_OFF =
  "M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20";
const EMAIL_SHAPE = /^\S+@\S+\.\S+$/;

/** Where to go after signing in: the page that sent us here, if it is one of ours. */
function nextPage(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <span id={id} className={s.error}>
      <Icon d={IC.bad} size={13} />
      {children}
    </span>
  );
}

export function SignIn({ fontClassName }: { fontClassName: string }) {
  const { mode, theme } = useSiteTheme();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);

  const emailError = tried && !EMAIL_SHAPE.test(email.trim()) ? (email.trim() ? "Enter a valid email address" : "Email is required") : "";
  const passwordError = tried && !password ? "Password is required" : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setServerError(null);
    if (!EMAIL_SHAPE.test(email.trim()) || !password) return;
    setBusy(true);
    try {
      await api.login(email.trim(), password, remember);
      // a full load, so every page and the map start with the new session
      window.location.assign(nextPage());
    } catch (err) {
      // the server's own words for a wrong password or too many tries; plain
      // words when it cannot be reached (restarting, offline) or failed
      const answered = err instanceof ApiError && err.status > 0 && err.status < 500;
      setServerError(answered ? (err as Error).message : "Can't reach the AgroTwin server right now. Check your connection and try again in a minute.");
      setBusy(false);
    }
  };

  return (
    <div className={`${l.root} ${s.page} ${fontClassName}`} data-theme={theme} suppressHydrationWarning>
      <ThemeScript />

      <div className={s.formSide}>
        <div className={s.top}>
          <Brand href="/" />
          <ThemeSwitch mode={mode} />
        </div>

        <main className={s.center}>
          <div className={s.column}>
            <div className={s.intro}>
              <div className={l.kicker}>SIGN IN · FARM SERVER</div>
              <h1 className={s.title}>Back to your twin.</h1>
              <p className={s.subtitle}>Your account lives on your own machine or farm server. Nothing is sent to a cloud.</p>
            </div>

            <form onSubmit={submit} noValidate className={s.form}>
              <label className={s.field}>
                <span className={s.fieldLabel}>EMAIL</span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  placeholder="you@farm.local"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!emailError}
                  aria-describedby={emailError ? "email-error" : undefined}
                  className={s.input}
                />
                {emailError && <FieldError id="email-error">{emailError}</FieldError>}
              </label>

              <div className={s.field}>
                <span className={s.fieldLabel}>
                  <label htmlFor="password">PASSWORD</label>
                  <button type="button" className={s.linkBtn} onClick={() => setShowReset((v) => !v)} aria-expanded={showReset}>
                    Forgot?
                  </button>
                </span>
                <span className={s.pwBox} data-invalid={!!passwordError}>
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!passwordError}
                    aria-describedby={passwordError ? "password-error" : undefined}
                    className={s.pwInput}
                  />
                  <button
                    type="button"
                    className={s.eyeBtn}
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    <Icon d={showPassword ? EYE_OFF : EYE} size={18} />
                  </button>
                </span>
                {passwordError && <FieldError id="password-error">{passwordError}</FieldError>}
                {showReset && (
                  <span className={s.hint}>
                    Passwords are reset by your AgroTwin contact at the university — ask them for a new one. You can change it under
                    Settings after signing in.
                  </span>
                )}
              </div>

              <button type="button" className={s.remember} aria-pressed={remember} onClick={() => setRemember((v) => !v)}>
                <span className={s.box}>
                  <Icon d={CHECK} size={12} strokeWidth={2.5} />
                </span>
                Keep this device signed in for field use
              </button>

              {serverError && (
                <span role="alert" className={s.error}>
                  <Icon d={IC.bad} size={13} />
                  {serverError}
                </span>
              )}

              <button type="submit" className={`${l.btn} ${l.cta} ${l.blueprint} ${s.submit}`} disabled={busy}>
                <Corners />
                {busy && <span className={s.spinner} aria-hidden="true" />}
                {busy ? "Connecting to farm server…" : "Sign In"}
              </button>
            </form>
          </div>
        </main>

        <div className={s.footer}>
          <span>No account? Ask your AgroTwin contact at the university.</span>
        </div>
      </div>

      <div className={s.picture}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/landing/hero-ndvi.jpg" alt="Calibrated NDVI map of the Ditty Road soybean field" className={l.fill} width={1100} height={756} decoding="async" />
        <div aria-hidden="true" className={s.crosshair} />
        <div className={s.lastSurvey}>
          <div className={l.telemetryTitle}>LAST SURVEY · DITTY_ROAD_S04</div>
          <div>
            Alt: 30.2m AGL | RTK Fix: <span className={l.okText}>FIXED</span>
          </div>
          <div>1,378 frames · 0.75 cm/px</div>
        </div>
        <div className={s.caption}>
          <div className={s.captionTitle}>Your farm imagery never leaves your control.</div>
          <div className={s.shares}>
            <span style={{ color: "var(--ok)" }}>Healthy 49.9%</span>
            <span style={{ color: "var(--warn)" }}>Attention 44.4%</span>
            <span style={{ color: "var(--bad)" }}>Problem 5.6%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
