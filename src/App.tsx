import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  NavLink,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import Plotly from "plotly.js-dist-min";
import plotlyFactory from "react-plotly.js/factory";
import {
  analyzeFaceLandmarks,
  exportResultCsv,
  getResolvedHarmony,
  getResolvedHarmonyOverall,
  HARMONY_BREAKDOWN_ROWS,
  normalizeScoresForCompare,
  PROFILE_DISCLAIMER,
  REGION_KEYS,
  resolveFaceProfile,
  scoreVariance,
} from "./lib/analysis";
import type { AnalysisResult } from "./lib/analysis";
import { detectFaceMesh } from "./lib/faceMesh";
import type { FacePoint } from "./lib/faceMesh";
import { compressDataUrlForStorage, isQuotaExceededError } from "./lib/storageImage";
import { apiLogin, apiRegister, apiSaveSession, apiGetSessions } from "./api";

const createPlotlyComponent =
  ((plotlyFactory as unknown as { default?: (p: unknown) => unknown }).default ?? plotlyFactory) as (
    plotly: unknown,
  ) => unknown;
const Plot = createPlotlyComponent(Plotly as unknown) as React.ComponentType<any>;

type User = {
  id: string;
  username: string;
  password: string;
  name: string;
  email: string;
  bio: string;
  phone: string;
  organization: string;
  location: string;
  website: string;
  timezone: string;
  role: "admin" | "analyst";
  avatarUrl: string;
  notificationsEmail: boolean;
  notificationsProduct: boolean;
  marketingOptIn: boolean;
  profileVisibility: "private" | "team" | "public";
  twoFactorEnabled: boolean;
  themePreference: "system" | "light" | "dark";
  createdAt: string;
};
type SavedSession = {
  id: string;
  userId: string;
  imageDataUrl: string;
  createdAt: string;
  result: AnalysisResult;
};

type DashboardOutletContext = {
  user: User;
  userSessions: SavedSession[];
  saveSession: (entry: SavedSession) => boolean;
  clearAllHistory: () => void;
};

const SESSIONS_KEY = "fas_sessions";
/** Bump this string to force a one-time wipe of `fas_sessions` for all clients (e.g. after storage format changes). */
const SESSIONS_SCHEMA_VERSION = "2";

function initSessionsFromStorage(): SavedSession[] {
  try {
    const v = localStorage.getItem("fas_sessions_schema");
    if (v !== SESSIONS_SCHEMA_VERSION) {
      localStorage.removeItem(SESSIONS_KEY);
      localStorage.setItem("fas_sessions_schema", SESSIONS_SCHEMA_VERSION);
      return [];
    }
  } catch {
    /* ignore */
  }
  return loadSessionsFromStorage();
}

function loadSessionsFromStorage(): SavedSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<SavedSession>[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((s, i) => ({
        id: typeof s.id === "string" ? s.id : `legacy-${i}-${Date.now()}`,
        userId: typeof s.userId === "string" ? s.userId : "",
        imageDataUrl: typeof s.imageDataUrl === "string" ? s.imageDataUrl : "",
        createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date(0).toISOString(),
        result: s.result as AnalysisResult,
      }))
      .filter((s) => s.imageDataUrl && s.result && typeof s.result.overallScore === "number");
  } catch {
    return [];
  }
}

function useAuthState() {
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem("fas_user");
    return raw ? JSON.parse(raw) : null;
  });

  const signIn = async (username: string, password: string) => {
    const data = await apiLogin(username, password);
    if (data.token) {
      localStorage.setItem("token", data.token);
      localStorage.setItem("fas_user", JSON.stringify(data.user));
      setUser(data.user);
      return { ok: true as const };
    }
    return { ok: false as const, message: data.message ?? "Invalid credentials." };
  };

  const signUp = async (payload: Pick<User, "username" | "password" | "name" | "email">) => {
    const data = await apiRegister(payload.name, payload.email, payload.username, payload.password);
    if (data.token) {
      localStorage.setItem("token", data.token);
      localStorage.setItem("fas_user", JSON.stringify(data.user));
      setUser(data.user);
      return { ok: true as const };
    }
    return { ok: false as const, message: data.message ?? "Unable to create account." };
  };

  const signOut = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("fas_user");
    setUser(null);
  };

  const updateProfile = (patch: Partial<User>) => {
    if (!user) return;
    const updated = { ...user, ...patch };
    localStorage.setItem("fas_user", JSON.stringify(updated));
    setUser(updated);
  };

  return { user, signIn, signUp, signOut, updateProfile };
}

function Shell({ user, onLogout }: { user: User | null; onLogout: () => void }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          IntelliFace AI
        </Link>
        <nav className="nav-links">
          <a href="/#features">Features</a>
          <a href="/#workflow">How it works</a>
          <a href="/#insights">Insights</a>
        </nav>
        <div className="topbar-right">
          {user ? (
            <>
              <Link className="button subtle" to="/dashboard">
                Workspace
              </Link>
              <Link className="button subtle" to="/profile">
                Profile
              </Link>
              <button onClick={onLogout}>Log out</button>
            </>
          ) : (
            <>
              <Link className="button subtle" to="/login">
                Login
              </Link>
              <Link className="button primary" to="/login">
                Get Started
              </Link>
            </>
          )}
          {location.pathname === "/dashboard" && <span className="chip">{user?.username}</span>}
        </div>
      </header>
      <main className="page-container">
        <Outlet />
      </main>
    </div>
  );
}

function ProtectedRoute({ user, children }: { user: User | null; children: ReactNode }) {
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const CONTOURS: number[][] = [
  [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
  [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362],
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 61],
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [336, 296, 334, 293, 300, 383, 372, 345, 352],
];

function buildLandmarkEdges(points: FacePoint[], maxNeighbors = 4, maxDistance = 0.06): Array<[number, number]> {
  const edges = new Set<string>();
  for (let i = 0; i < points.length; i += 1) {
    const distances: Array<{ idx: number; d: number }> = [];
    for (let j = 0; j < points.length; j += 1) {
      if (i === j) continue;
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= maxDistance) distances.push({ idx: j, d });
    }
    distances.sort((a, b) => a.d - b.d);
    for (const neighbor of distances.slice(0, maxNeighbors)) {
      const a = Math.min(i, neighbor.idx);
      const b = Math.max(i, neighbor.idx);
      edges.add(`${a}:${b}`);
    }
  }
  return [...edges].map((edge) => {
    const [a, b] = edge.split(":").map(Number);
    return [a, b] as [number, number];
  });
}

function drawOverlay(
  imageDataUrl: string,
  points: FacePoint[],
  edges: Array<[number, number]>,
  canvas: HTMLCanvasElement,
  showConnections: boolean,
) {
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    if (showConnections && points.length > 400) {
      ctx.globalAlpha = 0.33;
      ctx.strokeStyle = "#5f6cff";
      ctx.lineWidth = 0.9;
      for (const [a, b] of edges.slice(0, 1300)) {
        const p1 = points[a];
        const p2 = points[b];
        ctx.beginPath();
        ctx.moveTo(p1.x * canvas.width, p1.y * canvas.height);
        ctx.lineTo(p2.x * canvas.width, p2.y * canvas.height);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.3;
      for (const contour of CONTOURS) {
        ctx.beginPath();
        contour.forEach((idx, i) => {
          const p = points[idx];
          const x = p.x * canvas.width;
          const y = p.y * canvas.height;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const point of points) {
      const x = point.x * canvas.width;
      const y = point.y * canvas.height;
      const z = point.z * 300;
      const depthColor = Math.max(60, Math.min(235, Math.floor(190 + z)));
      ctx.fillStyle = `rgb(${depthColor - 20}, ${depthColor - 40}, 255)`;
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  image.src = imageDataUrl;
}

const LANDING_IMG_HERO =
  "https://faceshapelab.com/wp-content/uploads/2026/03/Face-Shape-Lab-2.png";
const LANDING_IMG_WORKFLOW =
  "https://www.face-symmetry-test.com/static/images/blog/person_with_face_analysis.png";
const LANDING_IMG_TEAMS =
  "https://bcw-media.s3.ap-northeast-1.amazonaws.com/strapi/assets/download_a4ea67914e.png";

type LandingFeature = {
  icon: string;
  title: string;
  body: string;
};

const LANDING_FEATURE_BANDS: { band: string; blurb: string; items: LandingFeature[] }[] = [
  {
    band: "From capture to structure",
    blurb: "Everything before the numbers: load the face, validate the shot, inspect landmarks, and confirm alignment.",
    items: [
      {
        icon: "📥",
        title: "Flexible intake & cropping",
        body: "Upload from your device or load a direct image URL—with fallbacks when a host blocks hotlinking. Draw a crop, snap to an automatic face frame, or use the full frame.",
      },
      {
        icon: "✓",
        title: "Quality gate",
        body: "Quick coverage and centering checks so tilted or undersized captures are caught before mesh generation.",
      },
      {
        icon: "✦",
        title: "468-point landmark overlay",
        body: "MediaPipe face mesh on the photo with optional connection lines, so structure is visible on the real image.",
      },
      {
        icon: "📐",
        title: "Symmetry axis & calibration",
        body: "Review the fitted midline from forehead, nasal bridge, philtrum, and chin landmarks before moving to depth.",
      },
    ],
  },
  {
    band: "From depth to export",
    blurb: "Explore geometry in 3D, then read harmony, regions, guidance, and a spreadsheet you can file away.",
    items: [
      {
        icon: "🧊",
        title: "3D mesh laboratory",
        body: "Interactive Plotly view—yaw, tilt, zoom, point size, mesh density, contours, and optional auto-spin for teaching or consult screens.",
      },
      {
        icon: "📊",
        title: "Harmony & regional analytics",
        body: "Overall harmony % plus per-region breakdown (eyes, brows, nose, mouth, ears, upper and lower cheek), asymmetry index, severity band, confidence, a harmony radar chart, and brief heuristic face-detail readouts (e.g. shape, tone) for context—not clinical labels.",
      },
      {
        icon: "💡",
        title: "Guided recommendations",
        body: "Short, metric-driven notes keyed to the strongest regional signals and capture quality—ready to pair with your own clinical judgment.",
      },
      {
        icon: "📄",
        title: "CSV export",
        body: "One download with composite scores, regional harmony and asymmetry columns, quality, confidence, and profile estimates for your records or tooling.",
      },
    ],
  },
];

function HomePage() {
  const highlights = [
    "468-point facial structure intelligence",
    "0-1000 asymmetry precision scale",
    "CSV-ready metrics and regional harmony views",
    "Built for rapid consultation workflows",
  ];

  return (
    <div className="site site-landing">
      <section className="hero hero-landing">
        <div className="hero-content">
          <div className="badge">Introducing next-gen facial analytics</div>
          <h1>
            AI Symmetry Insights for
            <span> Clinical & Aesthetic Review</span>
          </h1>
          <p>
            Empower your team with precision facial intelligence for screening, planning, and result communication.
            Designed to feel fast, modern, and production-ready from day one.
          </p>
          <div className="actions">
            <Link to="/login" className="button primary">
              Start Free Workspace
            </Link>
            <Link to="/signup" className="button">
              Create Account
            </Link>
            <a href="#workflow" className="button">
              See How It Works
            </a>
          </div>
          <div className="logo-strip">
            <span>Trusted by modern clinics</span>
            <div>
              <strong>NovaCare</strong>
              <strong>Auralis</strong>
              <strong>MediMorph</strong>
              <strong>FaceCore</strong>
            </div>
          </div>
        </div>
        <div className="hero-media">
          <img
            src={LANDING_IMG_HERO}
            alt="Facial mesh and landmark visualization for face shape analysis"
            width={1200}
            height={900}
            loading="eager"
            decoding="async"
            fetchPriority="high"
          />
        </div>
      </section>

      <section id="features" className="section section-landing features-landing-section">
        <div className="features-landing-header">
          <h2>Everything needed for precision assessment</h2>
          <p className="section-lead features-landing-lead">
            Guided steps from first pixel to downloadable metrics: intake, mesh, 3D review, harmony breakdown, and CSV—all
            matching what you run in the analysis wizard.
          </p>
        </div>
        <div className="features-bands">
          {LANDING_FEATURE_BANDS.map((group) => (
            <div key={group.band} className="features-band">
              <div className="features-band-head">
                <p className="features-band-kicker">{group.band}</p>
                <p className="features-band-blurb">{group.blurb}</p>
              </div>
              <div className="features-band-grid">
                {group.items.map((f) => (
                  <article key={f.title} className="feature-tile">
                    <div className="feature-tile-top">
                      <span className="feature-tile-icon" aria-hidden>
                        {f.icon}
                      </span>
                      <h3>{f.title}</h3>
                    </div>
                    <p>{f.body}</p>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="workflow" className="section section-landing split landing-split">
        <div className="landing-split-copy">
          <h2>Designed for a smooth consult workflow</h2>
          <ol className="steps">
            <li>Upload a frontal photo and validate quality.</li>
            <li>Generate multi-region asymmetry and harmony metrics instantly.</li>
            <li>Review severity, confidence, and recommendations.</li>
            <li>Export structured CSV metrics for records or downstream tools.</li>
          </ol>
        </div>
        <div className="landing-visual-wrap">
          <img
            src={LANDING_IMG_WORKFLOW}
            alt="Before and after style view of facial symmetry analysis overlays"
            width={1200}
            height={800}
            loading="lazy"
            decoding="async"
          />
        </div>
      </section>

      <section className="section section-landing split landing-split">
        <div className="landing-visual-wrap">
          <img
            src={LANDING_IMG_TEAMS}
            alt="Portrait with facial mesh overlay illustrating digital face analysis"
            width={1200}
            height={800}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className="landing-split-copy">
          <h2>Built for modern teams and detailed communication</h2>
          <p>
            Present insights with clear visuals, standardized metrics, and repeatable reporting so patient
            discussions stay consistent across your team.
          </p>
          <ul className="landing-checklist">
            <li>Standardized consultation output</li>
            <li>Visual-first score interpretation</li>
            <li>Export-ready records</li>
          </ul>
        </div>
      </section>

      <section id="insights" className="section section-landing">
        <h2>Why teams choose IntelliFace AI</h2>
        <p className="section-lead">Reliability and clarity at every step of the assessment pipeline.</p>
        <div className="grid four insights-grid">
          {highlights.map((item) => (
            <div key={item} className="metric-card metric-card-landing">
              <h3>{item}</h3>
              <p>Engineered for reliability, speed, and a premium product experience.</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section section-landing">
        <h2>Frequently asked questions</h2>
        <div className="grid two faq-grid">
          <article className="feature-card feature-card-landing">
            <h3>Can I track progress over time?</h3>
            <p>Yes. Each analyzed session can be saved and compared in your dashboard history.</p>
          </article>
          <article className="feature-card feature-card-landing">
            <h3>Does it support professional reporting?</h3>
            <p>CSV exports and structured metrics are included for audit-friendly records.</p>
          </article>
        </div>
      </section>

      <section className="section section-landing cta cta-landing">
        <h2>Start delivering modern facial analytics</h2>
        <p>Switch from manual guesswork to fast data-supported consultations.</p>
        <div className="actions cta-actions">
          <Link to="/login" className="button primary">
            Access Platform
          </Link>
          <Link to="/signup" className="button">
            Create account
          </Link>
        </div>
      </section>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (u: string, p: string) => Promise<{ ok: boolean; message?: string }> }) {
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("12345");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await onLogin(username, password);
    if (result.ok) {
      navigate("/dashboard");
      return;
    }
    setError(result.message ?? "Unable to login.");
  };
  return (
    <section className="panel narrow">
      <h2>Welcome back</h2>
      <p>Sign in to your workspace.</p>
      <form onSubmit={submit} className="form">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="button primary" type="submit">
          Login
        </button>
      </form>
    </section>
  );
}

function SignupPage({ onSignup }: { onSignup: (payload: Pick<User, "username" | "password" | "name" | "email">) => Promise<{ ok: boolean; message?: string }> }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await onSignup({ name, email, username, password });
    if (!result.ok) return setError(result.message ?? "Unable to create account.");
    navigate("/dashboard/new");
  };
  return (
    <section className="panel narrow">
      <h2>Create account</h2>
      <form onSubmit={submit} className="form">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button className="button primary" type="submit">Sign up</button>
      </form>
    </section>
  );
}

function ProfilePage({ user }: { user: User }) {
  return (
    <section className="panel">
      <h2>Profile</h2>
      <div className="profile-card">
        <img src={user.avatarUrl} alt={user.name} />
        <div>
          <h3>{user.name}</h3>
          <p>@{user.username}</p>
          <p>{user.email}</p>
          {user.phone && <p>{user.phone}</p>}
          {user.organization && <p>{user.organization}</p>}
          <p>{user.bio || "No bio added yet."}</p>
          <Link className="button primary" to="/profile/edit">Edit Profile</Link>
        </div>
      </div>
    </section>
  );
}

function EditProfilePage({ user, onUpdate }: { user: User; onUpdate: (patch: Partial<User>) => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [phone, setPhone] = useState(user.phone);
  const [organization, setOrganization] = useState(user.organization);
  const [location, setLocation] = useState(user.location);
  const [website, setWebsite] = useState(user.website);
  const [timezone, setTimezone] = useState(user.timezone);
  const [bio, setBio] = useState(user.bio);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [notificationsEmail, setNotificationsEmail] = useState(user.notificationsEmail);
  const [notificationsProduct, setNotificationsProduct] = useState(user.notificationsProduct);
  const [marketingOptIn, setMarketingOptIn] = useState(user.marketingOptIn);
  const [profileVisibility, setProfileVisibility] = useState<User["profileVisibility"]>(user.profileVisibility);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(user.twoFactorEnabled);
  const [themePreference, setThemePreference] = useState<User["themePreference"]>(user.themePreference);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState("");

  const onAvatarFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    const passwordPatch: Partial<User> = {};
    if (newPassword || confirmPassword || currentPassword) {
      if (currentPassword !== user.password) {
        setFormError("Current password is incorrect.");
        return;
      }
      if (newPassword.length < 6) {
        setFormError("New password must be at least 6 characters.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setFormError("New password and confirm password do not match.");
        return;
      }
      passwordPatch.password = newPassword;
    }
    onUpdate({
      name,
      email,
      phone,
      organization,
      location,
      website,
      timezone,
      bio,
      avatarUrl,
      notificationsEmail,
      notificationsProduct,
      marketingOptIn,
      profileVisibility,
      twoFactorEnabled,
      themePreference,
      ...passwordPatch,
    });
    navigate("/profile");
  };
  return (
    <section className="panel">
      <h2>Edit Profile</h2>
      <form className="profile-form" onSubmit={submit}>
        <div className="profile-section">
          <h3>Identity</h3>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Username<input value={user.username} disabled /></label>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 123 4567" /></label>
          <label>Organization<input value={organization} onChange={(e) => setOrganization(e.target.value)} /></label>
          <label>Location<input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
          <label>Website<input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://your-site.com" /></label>
          <label>Timezone<input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
          <label>Bio<textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} /></label>
        </div>

        <div className="profile-section">
          <h3>Avatar</h3>
          <img className="avatar-preview" src={avatarUrl} alt="Profile preview" />
          <label>Avatar URL<input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} /></label>
          <label>Upload Avatar Image<input type="file" accept="image/*" onChange={onAvatarFile} /></label>
        </div>

        <div className="profile-section">
          <h3>Security</h3>
          <label>Current Password<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
          <label>New Password<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></label>
          <label>Confirm New Password<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>
          <label className="checkbox"><input type="checkbox" checked={twoFactorEnabled} onChange={(e) => setTwoFactorEnabled(e.target.checked)} />Enable 2-factor security</label>
        </div>

        <div className="profile-section">
          <h3>Preferences</h3>
          <label className="checkbox"><input type="checkbox" checked={notificationsEmail} onChange={(e) => setNotificationsEmail(e.target.checked)} />Email notifications</label>
          <label className="checkbox"><input type="checkbox" checked={notificationsProduct} onChange={(e) => setNotificationsProduct(e.target.checked)} />Product update alerts</label>
          <label className="checkbox"><input type="checkbox" checked={marketingOptIn} onChange={(e) => setMarketingOptIn(e.target.checked)} />Marketing emails</label>
          <label>
            Profile visibility
            <select value={profileVisibility} onChange={(e) => setProfileVisibility(e.target.value as User["profileVisibility"])}>
              <option value="private">Private</option>
              <option value="team">Team</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label>
            Theme preference
            <select value={themePreference} onChange={(e) => setThemePreference(e.target.value as User["themePreference"])}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>Role<input value={user.role} disabled /></label>
        </div>

        {formError && <p className="error">{formError}</p>}
        <div className="actions left">
          <button type="button" onClick={() => navigate("/profile")}>Cancel</button>
          <button className="button primary" type="submit">Save advanced profile</button>
        </div>
      </form>
    </section>
  );
}

function DashboardLayout({ user }: { user: User }) {
  const [sessions, setSessions] = useState<SavedSession[]>(() => initSessionsFromStorage());

  const saveSession = useCallback((entry: SavedSession) => {
    if (!entry.imageDataUrl?.trim() || !entry.result || typeof entry.result.overallScore !== "number") {
      console.warn("saveSession: invalid entry, skipping.");
      return false;
    }
    const existing = loadSessionsFromStorage();
    let next: SavedSession[] = [entry, ...existing.filter((s) => s.id !== entry.id)];

    while (next.length >= 1) {
      const capped = next.slice(0, 80);
      try {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(capped));
        setSessions(capped);
        return true;
      } catch (err) {
        if (isQuotaExceededError(err) && next.length > 1) {
          next = next.slice(0, -1);
          continue;
        }
        console.error("Failed to persist session history.", err);
        return false;
      }
    }
    return false;
  }, []);

  const clearAllHistory = useCallback(() => {
    try {
      localStorage.setItem(SESSIONS_KEY, "[]");
    } catch {
      try {
        localStorage.removeItem(SESSIONS_KEY);
      } catch {
        /* ignore */
      }
    }
    setSessions([]);
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") setSessions(loadSessionsFromStorage());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === SESSIONS_KEY) setSessions(loadSessionsFromStorage());
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const userSessions = useMemo(() => {
    return sessions
      .filter((s) => s.userId === user.id || s.userId === "")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [sessions, user.id]);

  const outletCtx = useMemo<DashboardOutletContext>(
    () => ({ user, userSessions, saveSession, clearAllHistory }),
    [user, userSessions, saveSession, clearAllHistory],
  );

  return (
    <section className="workspace">
      <aside className="workspace-menu">
        <h3>Workspace</h3>
        <NavLink to="/dashboard/new" className={({ isActive }) => (isActive ? "active" : "")}>
          New Analysis
        </NavLink>
        <NavLink to="/dashboard/history" className={({ isActive }) => (isActive ? "active" : "")}>
          History
        </NavLink>
        <NavLink to="/dashboard/compare" className={({ isActive }) => (isActive ? "active" : "")}>
          Compare
        </NavLink>
      </aside>
      <div className="workspace-content">
        <Outlet context={outletCtx} />
      </div>
    </section>
  );
}

function NewAnalysisPage() {
  useOutletContext<DashboardOutletContext>();
  const [intakeImageSrc, setIntakeImageSrc] = useState<string>("");
  const [imageDataUrl, setImageDataUrl] = useState<string>("");
  const [imageUrlInput, setImageUrlInput] = useState("");
  const [step, setStep] = useState(1);
  const [points, setPoints] = useState<FacePoint[]>([]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [showConnections, setShowConnections] = useState(true);
  const [meshRotate, setMeshRotate] = useState(34);
  const [meshTilt, setMeshTilt] = useState(8);
  const [meshZoom, setMeshZoom] = useState(1.2);
  const [pointSize, setPointSize] = useState(2.6);
  const [meshDensity, setMeshDensity] = useState(1);
  const [autoSpin, setAutoSpin] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const [urlFallbackInfo, setUrlFallbackInfo] = useState("");
  const [cropRect, setCropRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [isSelectingCrop, setIsSelectingCrop] = useState(false);
  const [cropDragMode, setCropDragMode] = useState<"draw" | "move" | null>(null);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [cropDragOffset, setCropDragOffset] = useState<{ x: number; y: number } | null>(null);
  const [imageMeta, setImageMeta] = useState<{ width: number; height: number } | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const intakeImageRef = useRef<HTMLImageElement | null>(null);
  const [cameraAngle, setCameraAngle] = useState(0);

  const chartData = useMemo(() => {
    if (!result) return [];
    const harmony = getResolvedHarmony(result);
    return REGION_KEYS.map((region) => ({ region, harmony: harmony[region] }));
  }, [result]);

  const analysisExtras = useMemo(() => {
    if (!result) return null;
    return {
      harmony: getResolvedHarmony(result),
      profile: resolveFaceProfile(result),
      normScores: normalizeScoresForCompare(result.scores as Record<string, number>),
    };
  }, [result]);

  const qualityMetrics = useMemo(() => {
    if (!points.length) return null;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
    const centeredness = 1 - Math.min(1, Math.hypot(centerX - 0.5, centerY - 0.5) * 2);
    const coverage = Math.min(1, (width * height) / 0.23);
    const qualityScore = Math.round((centeredness * 0.45 + coverage * 0.55) * 100);
    const poseReady = qualityScore >= 55;
    return { width, height, centeredness, coverage, qualityScore, poseReady };
  }, [points]);

  const meshEdges = useMemo(() => {
    if (points.length < 50) return [] as Array<[number, number]>;
    return buildLandmarkEdges(points, 4, 0.06);
  }, [points]);

  const sampledPoints = useMemo(() => {
    if (!points.length) return [];
    if (meshDensity >= 1) return points;
    const step = Math.max(1, Math.round(1 / meshDensity));
    return points.filter((_, i) => i % step === 0);
  }, [points, meshDensity]);

  const contourLineIndices = useMemo(
    () => [
      [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109, 10],
      [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 33],
      [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398, 362],
      [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 61],
      [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
      [336, 296, 334, 293, 300, 383, 372, 345, 352],
    ],
    [],
  );

  const meshPlotData = useMemo(() => {
    if (!points.length) return [];
    const x = sampledPoints.map((p) => (p.x - 0.5) * 2.0);
    const y = sampledPoints.map((p) => (0.5 - p.y) * 2.2);
    const z = sampledPoints.map((p) => -p.z * 2.4);
    const colors = sampledPoints.map((p) => 0.5 - p.z);

    const traces: any[] = [
      {
        type: "mesh3d",
        x,
        y,
        z,
        alphahull: 5,
        opacity: 0.15,
        color: "#8ea3ff",
        hoverinfo: "none",
      },
      {
        type: "scatter3d",
        mode: "markers",
        x,
        y,
        z,
        marker: {
          size: pointSize,
          color: colors,
          colorscale: [
            [0, "#7f8cff"],
            [0.5, "#9db6ff"],
            [1, "#d7e2ff"],
          ],
          opacity: 0.95,
        },
        hoverinfo: "none",
      },
    ];

    if (showConnections) {
      for (const contour of contourLineIndices) {
        traces.push({
          type: "scatter3d",
          mode: "lines",
          x: contour.map((idx: number) => (points[idx].x - 0.5) * 2.0),
          y: contour.map((idx: number) => (0.5 - points[idx].y) * 2.2),
          z: contour.map((idx: number) => -points[idx].z * 2.4),
          line: { color: "#5f6eff", width: 4 },
          opacity: 0.65,
          hoverinfo: "none",
        });
      }

      // sparse web lines for structure depth cues
      const webX: Array<number | null> = [];
      const webY: Array<number | null> = [];
      const webZ: Array<number | null> = [];
      for (const [a, b] of meshEdges.slice(0, 550)) {
        const p1 = points[a];
        const p2 = points[b];
        webX.push((p1.x - 0.5) * 2.0, (p2.x - 0.5) * 2.0, null);
        webY.push((0.5 - p1.y) * 2.2, (0.5 - p2.y) * 2.2, null);
        webZ.push(-p1.z * 2.4, -p2.z * 2.4, null);
      }
      traces.push({
        type: "scatter3d",
        mode: "lines",
        x: webX,
        y: webY,
        z: webZ,
        line: { color: "rgba(159,172,255,0.4)", width: 1 },
        hoverinfo: "none",
      });
    }

    return traces;
  }, [contourLineIndices, meshEdges, pointSize, points, sampledPoints, showConnections]);

  useEffect(() => {
    if (!autoSpin) return;
    const id = window.setInterval(() => {
      setCameraAngle((prev) => (prev + 0.018) % (Math.PI * 2));
    }, 20);
    return () => window.clearInterval(id);
  }, [autoSpin]);

  const processImageSource = async (src: string, useCrossOrigin = false) => {
    setIntakeImageSrc("");
    setImageDataUrl("");
    setPoints([]);
    setResult(null);
    setCropRect(null);
    setDetecting(true);
    setError("");
    setUrlFallbackInfo("");

    const candidates: Array<{ url: string; label: string; crossOrigin?: boolean }> = [
      { url: src, label: "direct", crossOrigin: useCrossOrigin },
      {
        url: `https://images.weserv.nl/?url=${encodeURIComponent(src.replace(/^https?:\/\//, ""))}`,
        label: "proxy-1",
        crossOrigin: true,
      },
      {
        url: `https://corsproxy.io/?${encodeURIComponent(src)}`,
        label: "proxy-2",
        crossOrigin: true,
      },
    ];

    const tryLoad = (candidate: { url: string; label: string; crossOrigin?: boolean }) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        if (candidate.crossOrigin) image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("load_failed"));
        image.src = candidate.url;
      });

    let loadedImage: HTMLImageElement | null = null;
    let loadedFrom = "direct";
    for (const candidate of candidates) {
      try {
        loadedImage = await tryLoad(candidate);
        loadedFrom = candidate.label;
        break;
      } catch {
        // try next candidate
      }
    }

    if (!loadedImage) {
      setDetecting(false);
      setError(
        "Image URL could not be loaded. Try a direct image link (.jpg/.png/.webp) or upload from device.",
      );
      return;
    }

    setIntakeImageSrc(loadedImage.src);
    setImageMeta({ width: loadedImage.naturalWidth, height: loadedImage.naturalHeight });
    if (loadedFrom !== "direct") {
      setUrlFallbackInfo(`Loaded through ${loadedFrom} fallback to bypass host restrictions.`);
    }
    setDetecting(false);
  };

  const runDetectionFromSource = async (src: string) => {
    setDetecting(true);
    setError("");
    const image = new Image();
    image.onload = async () => {
      try {
        const detected = await detectFaceMesh(image);
        if (!detected.length) {
          setError("No face detected. Please upload a clearer frontal image.");
          setStep(1);
          return;
        }
        setImageDataUrl(src);
        setImageMeta({ width: image.naturalWidth, height: image.naturalHeight });
        setPoints(detected);
        setStep(2);
      } catch {
        setError("Face mesh initialization failed. Please retry.");
      } finally {
        setDetecting(false);
      }
    };
    image.onerror = () => {
      setDetecting(false);
      setError("Failed to process cropped image.");
    };
    image.src = src;
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      processImageSource(src);
    };
    reader.readAsDataURL(file);
  };

  const onUrlUpload = () => {
    if (!imageUrlInput.trim()) return;
    void processImageSource(imageUrlInput.trim(), true);
  };

  const toImageCoords = (event: ReactMouseEvent<HTMLElement>) => {
    const img = intakeImageRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
    const y = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
    return { x, y, width: rect.width, height: rect.height };
  };

  const onCropMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    const pos = toImageCoords(event);
    if (!pos) return;
    if (
      cropRect &&
      pos.x >= cropRect.x &&
      pos.x <= cropRect.x + cropRect.w &&
      pos.y >= cropRect.y &&
      pos.y <= cropRect.y + cropRect.h
    ) {
      setCropDragMode("move");
      setIsSelectingCrop(true);
      setCropDragOffset({ x: pos.x - cropRect.x, y: pos.y - cropRect.y });
      return;
    }
    setCropDragMode("draw");
    setIsSelectingCrop(true);
    setCropStart({ x: pos.x, y: pos.y });
    setCropRect({ x: pos.x, y: pos.y, w: 0, h: 0 });
  };

  const onCropMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    if (!isSelectingCrop) return;
    const pos = toImageCoords(event);
    if (!pos) return;
    if (cropDragMode === "move" && cropRect && cropDragOffset) {
      const x = Math.max(0, Math.min(pos.width - cropRect.w, pos.x - cropDragOffset.x));
      const y = Math.max(0, Math.min(pos.height - cropRect.h, pos.y - cropDragOffset.y));
      setCropRect({ ...cropRect, x, y });
      return;
    }
    if (!cropStart) return;
    const x1 = Math.min(cropStart.x, pos.x);
    const y1 = Math.min(cropStart.y, pos.y);
    const x2 = Math.max(cropStart.x, pos.x);
    const y2 = Math.max(cropStart.y, pos.y);
    setCropRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
  };

  const onCropMouseUp = () => {
    if (cropRect && (cropRect.w < 12 || cropRect.h < 12)) {
      setCropRect(null);
    }
    setIsSelectingCrop(false);
    setCropDragMode(null);
    setCropStart(null);
    setCropDragOffset(null);
  };

  const useFullImageCrop = () => {
    const img = intakeImageRef.current;
    if (!img) return;
    setCropRect({ x: 0, y: 0, w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height });
  };

  const autoCropToFace = async () => {
    if (!intakeImageSrc || !intakeImageRef.current) return;
    const image = new Image();
    image.onload = async () => {
      try {
        const detected = await detectFaceMesh(image);
        if (!detected.length) return;
        const xs = detected.map((p) => p.x);
        const ys = detected.map((p) => p.y);
        const minX = Math.max(0, Math.min(...xs) - 0.08);
        const maxX = Math.min(1, Math.max(...xs) + 0.08);
        const minY = Math.max(0, Math.min(...ys) - 0.1);
        const maxY = Math.min(1, Math.max(...ys) + 0.1);
        const rect = intakeImageRef.current?.getBoundingClientRect();
        if (!rect) return;
        setCropRect({
          x: minX * rect.width,
          y: minY * rect.height,
          w: (maxX - minX) * rect.width,
          h: (maxY - minY) * rect.height,
        });
      } catch {
        // Keep manual crop as fallback.
      }
    };
    image.src = intakeImageSrc;
  };

  const applyCropAndContinue = async () => {
    if (!intakeImageSrc) return;
    const image = new Image();
    image.onload = async () => {
      const displayRect = intakeImageRef.current?.getBoundingClientRect();
      const c = cropRect;
      let cropX = 0;
      let cropY = 0;
      let cropW = image.naturalWidth;
      let cropH = image.naturalHeight;
      if (displayRect && c && c.w > 10 && c.h > 10) {
        const scaleX = image.naturalWidth / displayRect.width;
        const scaleY = image.naturalHeight / displayRect.height;
        cropX = Math.floor(c.x * scaleX);
        cropY = Math.floor(c.y * scaleY);
        cropW = Math.floor(c.w * scaleX);
        cropH = Math.floor(c.h * scaleY);
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, cropW);
      canvas.height = Math.max(1, cropH);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(image, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
      const croppedSrc = canvas.toDataURL("image/png");
      await runDetectionFromSource(croppedSrc);
    };
    image.src = intakeImageSrc;
  };

  useEffect(() => {
    if (step !== 3) return;
    if (!overlayCanvasRef.current || !imageDataUrl || points.length === 0) return;
    drawOverlay(imageDataUrl, points, meshEdges, overlayCanvasRef.current, showConnections);
  }, [imageDataUrl, meshEdges, points, showConnections, step]);

  const runAnalysis = () => {
    if (!imageDataUrl || points.length < 455) {
      setError("Need a processed face image and full landmark set before analysis.");
      return;
    }
    setError("");
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      let pixelData: ImageData | null = null;
      if (ctx) {
        ctx.drawImage(image, 0, 0);
        try {
          pixelData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch {
          pixelData = null;
        }
      }
      const output = analyzeFaceLandmarks(points, pixelData);
      if (!output) {
        setError("Unable to compute landmark-based analysis for this image.");
        return;
      }
      setResult(output);
      setStep(6);
    };
    image.onerror = () => {
      const output = analyzeFaceLandmarks(points, null);
      if (!output) {
        setError("Unable to compute landmark-based analysis for this image.");
        return;
      }
      setResult(output);
      setStep(6);
    };
    image.src = imageDataUrl;
  };

  const downloadCsv = (activeResult: AnalysisResult) => {
    const csv = exportResultCsv(activeResult);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "facial-analysis-report.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const saveToHistory = () => {
    if (!result) {
      setError("Run analysis first before saving.");
      return;
    }
    if (!imageDataUrl?.trim()) {
      setError("Cannot save: no processed image.");
      return;
    }
    setError("");
    void (async () => {
      const thumb = await compressDataUrlForStorage(imageDataUrl, { maxEdge: 720, quality: 0.76 });
      const data = await apiSaveSession(thumb, result);
      if (data.id) {
        setStep(8);
      } else {
        setError("Failed to save session. Please try again.");
      }
    })();
  };

  return (
    <section className="panel">
      <h2>Step-by-Step Analysis Wizard</h2>
      <div className="wizard-steps">
        {["Intake", "Quality", "Landmarks", "Calibration", "3D Mesh", "Analysis", "Recommendations", "Export"].map((item, i) => (
          <span key={item} className={step >= i + 1 ? "active" : ""}>
            {i + 1}. {item}
          </span>
        ))}
      </div>

      {step === 1 && (
        <div className="panel alt intake-panel">
          <h3>Step 1: Image Intake</h3>
          <p>Upload a facial image from your device or paste a direct image URL, then crop to the face.</p>
          <div className="upload-grid">
            <div className="glass-upload-card">
              <h4>Device Upload</h4>
              <input type="file" accept="image/*" onChange={onFile} />
              <p className="upload-tip">Best results: clear frontal face, good lighting, minimal tilt.</p>
            </div>
            <div className="glass-upload-card">
              <h4>URL Upload</h4>
              <input
                type="url"
                placeholder="https://example.com/face-image.jpg"
                value={imageUrlInput}
                onChange={(e) => setImageUrlInput(e.target.value)}
              />
              <button className="button primary" onClick={onUrlUpload}>
                Load from URL
              </button>
              <p className="upload-tip">Use direct image links ending in jpg/png/webp.</p>
            </div>
          </div>
          {intakeImageSrc && (
            <div className="crop-stage">
              <h4>Interactive Crop</h4>
              <p className="upload-tip">Drag on image to select face crop, then apply.</p>
              <div
                className="crop-image-wrap"
                onMouseDown={onCropMouseDown}
                onMouseMove={onCropMouseMove}
                onMouseUp={onCropMouseUp}
                onMouseLeave={onCropMouseUp}
              >
                <img ref={intakeImageRef} src={intakeImageSrc} alt="Crop source" className="crop-image" />
                {cropRect && (
                  <div
                    className="crop-rect"
                    style={{ left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }}
                  />
                )}
              </div>
              <div className="actions left">
                <button type="button" onClick={() => void autoCropToFace()}>Auto Face Crop</button>
                <button type="button" onClick={useFullImageCrop}>Use Full Image</button>
                <button type="button" onClick={() => setCropRect(null)}>Reset Crop</button>
                <button className="button primary" type="button" onClick={() => void applyCropAndContinue()}>
                  Apply Crop & Continue
                </button>
              </div>
              {cropRect && (
                <p className="upload-tip">
                  Crop selection: {Math.round(cropRect.w)} x {Math.round(cropRect.h)} px (display scale)
                </p>
              )}
            </div>
          )}
          {detecting && <p>Detecting 468 facial landmarks...</p>}
          {error && <p className="error">{error}</p>}
          {urlFallbackInfo && <p className="success">{urlFallbackInfo}</p>}
        </div>
      )}

      {step === 2 && imageDataUrl && (
        <div className="panel alt">
          <h3>Step 2: Image Quality Gate</h3>
          <p>Pre-check framing and pose quality before structural analysis.</p>
          <div className="source-preview">
            <img src={imageDataUrl} alt="Uploaded source preview" className="source-preview-image" />
            {imageMeta && (
              <p className="upload-tip">
                Original dimensions: {imageMeta.width} x {imageMeta.height}
              </p>
            )}
          </div>
          {qualityMetrics && (
            <div className="grid two">
              <div className="feature-card">
                <h4>Quality Score: {qualityMetrics.qualityScore}/100</h4>
                <p>Face coverage: {(qualityMetrics.coverage * 100).toFixed(0)}%</p>
                <p>Centeredness: {(qualityMetrics.centeredness * 100).toFixed(0)}%</p>
              </div>
              <div className="feature-card">
                <h4>Readiness</h4>
                <p>{qualityMetrics.poseReady ? "Ready for high-confidence analysis." : "Re-capture recommended for better consistency."}</p>
              </div>
            </div>
          )}
          <div className="actions left">
            <button onClick={() => setStep(1)}>Back</button>
            <button className="button primary" onClick={() => setStep(3)}>Continue to Landmarks</button>
          </div>
        </div>
      )}

      {step === 3 && imageDataUrl && (
        <div className="panel alt">
          <h3>Step 3: Landmark Overlay</h3>
          <p>Inspect generated facial landmarks and optional mesh connections.</p>
          <div className="actions left">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showConnections}
                onChange={(e) => setShowConnections(e.target.checked)}
              />
              Show mesh connections
            </label>
            <button onClick={() => setStep(2)}>Back</button>
            <button className="button primary" onClick={() => setStep(4)}>
              Continue
            </button>
          </div>
          <div className="canvas-stage">
            <canvas
              ref={overlayCanvasRef}
              className="analysis-canvas"
              style={imageMeta ? { aspectRatio: `${imageMeta.width} / ${imageMeta.height}` } : undefined}
            />
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="panel alt">
          <h3>Step 4: Calibration & Symmetry Axis</h3>
          <p>Confirm the detected central facial axis and readiness before depth inspection.</p>
          <div className="feature-card">
            <p>
              The system uses landmarks around forehead, nasal bridge, philtrum, and chin to stabilize sagittal alignment.
              Proceed when overlay alignment looks anatomically consistent.
            </p>
          </div>
          <div className="actions left">
            <button onClick={() => setStep(3)}>Back</button>
            <button className="button primary" onClick={() => setStep(5)}>Open 3D Mesh Lab</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="panel alt">
          <h3>Step 5: 3D Mesh Lab</h3>
          <p>Interactive anatomical 3D view with depth shading and camera controls.</p>
          <label>
            Yaw Rotation
            <input type="range" min={0} max={360} value={meshRotate} onChange={(e) => setMeshRotate(Number(e.target.value))} />
          </label>
          <label>Tilt<input type="range" min={-45} max={45} value={meshTilt} onChange={(e) => setMeshTilt(Number(e.target.value))} /></label>
          <label>Zoom<input type="range" min={0.8} max={1.6} step={0.01} value={meshZoom} onChange={(e) => setMeshZoom(Number(e.target.value))} /></label>
          <label>Point Size<input type="range" min={0.7} max={2.4} step={0.1} value={pointSize} onChange={(e) => setPointSize(Number(e.target.value))} /></label>
          <label>Mesh Density<input type="range" min={0.2} max={1} step={0.1} value={meshDensity} onChange={(e) => setMeshDensity(Number(e.target.value))} /></label>
          <label className="checkbox"><input type="checkbox" checked={autoSpin} onChange={(e) => setAutoSpin(e.target.checked)} />Auto-spin mesh</label>
          <div className="mesh-plot-wrap">
            <Plot
              data={meshPlotData}
              layout={{
                autosize: true,
                margin: { l: 0, r: 0, b: 0, t: 0 },
                paper_bgcolor: "#0d1029",
                plot_bgcolor: "#0d1029",
                scene: {
                  xaxis: { visible: false },
                  yaxis: { visible: false },
                  zaxis: { visible: false },
                  aspectratio: { x: 1, y: 1.15, z: 0.7 },
                  camera: {
                    eye: {
                      x: Math.cos((meshRotate * Math.PI) / 180 + cameraAngle) * meshZoom * 1.35,
                      y: Math.sin((meshRotate * Math.PI) / 180 + cameraAngle) * meshZoom * 1.35,
                      z: 0.68 + meshTilt / 120,
                    },
                  },
                },
                showlegend: false,
              }}
              config={{
                displaylogo: false,
                responsive: true,
                modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
              }}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
          <div className="actions left">
            <button onClick={() => setStep(4)}>Back</button>
            <button className="button primary" onClick={runAnalysis}>
              Run Analysis
            </button>
          </div>
        </div>
      )}

      {step === 6 && result && analysisExtras && (
        <div className="panel alt analysis-harmony-panel">
          <h3>Step 6: Facial harmony & regional detail</h3>
          <p className="analysis-disclaimer">{PROFILE_DISCLAIMER}</p>

          <div className="harmony-hero">
            <span className="harmony-hero-emoji" aria-hidden>✨</span>
            <div>
              <div className="harmony-hero-label">Overall</div>
              <div className="harmony-hero-value">{getResolvedHarmonyOverall(result)}%</div>
              <div className="harmony-hero-sub">
                Composite symmetry signal · raw score {result.overallScore.toFixed(1)}/1000
              </div>
            </div>
          </div>

          <h4>Feature-by-feature breakdown</h4>
          <p className="upload-tip">
            Harmony % is derived from regional asymmetry scores (higher % means closer bilateral balance on this model).
          </p>
          <div className="harmony-breakdown">
            {HARMONY_BREAKDOWN_ROWS.map((row) => {
              const pct = analysisExtras.harmony[row.key];
              return (
                <div key={row.key} className="harmony-row">
                  <span className="harmony-row-icon" aria-hidden>{row.emoji}</span>
                  <span className="harmony-row-label">{row.label}</span>
                  <div
                    className="harmony-bar-track"
                    title={`Asymmetry ${analysisExtras.normScores[row.key].toFixed(1)} / 1000`}
                  >
                    <div className="harmony-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="harmony-row-pct">{pct}%</span>
                </div>
              );
            })}
          </div>

          <h4>Face details (estimated)</h4>
          <div className="profile-detail-grid">
            <div className="profile-detail-card">
              <span className="profile-detail-emoji" aria-hidden>👤</span>
              <div>
                <small>Gender</small>
                <strong>{analysisExtras.profile.genderPresentation}</strong>
              </div>
            </div>
            <div className="profile-detail-card">
              <span className="profile-detail-emoji" aria-hidden>🎂</span>
              <div>
                <small>Est. age</small>
                <strong>{analysisExtras.profile.ageEstimateYears} yrs</strong>
              </div>
            </div>
            <div className="profile-detail-card">
              <span className="profile-detail-emoji" aria-hidden>🔷</span>
              <div>
                <small>Face shape</small>
                <strong>{analysisExtras.profile.faceShape}</strong>
              </div>
            </div>
            <div className="profile-detail-card">
              <span className="profile-detail-emoji" aria-hidden>🎨</span>
              <div>
                <small>Skin tone</small>
                <strong>{analysisExtras.profile.skinToneCategory}</strong>
              </div>
            </div>
          </div>

          <div className="grid two analysis-split">
            <div className="feature-card analysis-metrics-card">
              <h4>Technical summary</h4>
              <p>
                Asymmetry index: <strong>{result.asymmetryIndex}%</strong> (0–100 scale from composite)
              </p>
              <p>
                Severity band: <strong>{result.severity}</strong>
              </p>
              <p>
                Primary region (highest asymmetry signal): <strong>{String(result.worstRegion)}</strong>
              </p>
              <p>
                Capture quality: <strong>{result.quality}/100</strong>
              </p>
              <p>
                Model confidence: <strong>{Math.round(result.confidence * 100)}%</strong>
              </p>
              <p>
                Regional score spread: <strong>{scoreVariance(result)}</strong>
              </p>
            </div>
            <div className="feature-card">
              <h4>Harmony radar (by region)</h4>
              <div className="chart-wrap harmony-radar-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={chartData}>
                    <PolarGrid stroke="#d2d7ff" />
                    <PolarAngleAxis dataKey="region" tick={{ fontSize: 11 }} />
                    <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                    <Radar dataKey="harmony" stroke="#7066ff" fill="#7066ff" fillOpacity={0.35} name="Harmony %" />
                    <Tooltip formatter={(v) => [`${v ?? ""}%`, "Harmony"]} />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {imageDataUrl && (
            <div className="analysis-thumb-row">
              <img src={imageDataUrl} alt="Analyzed face" className="analysis-thumb" />
            </div>
          )}

          <div className="actions left">
            <button type="button" onClick={() => setStep(5)}>Back</button>
            <button type="button" className="button primary" onClick={() => setStep(7)}>
              Continue to recommendations
            </button>
          </div>
        </div>
      )}

      {step === 7 && result && (
        <div className="panel alt">
          <h3>Step 7: Recommendations & export</h3>
          <p className="upload-tip">{PROFILE_DISCLAIMER}</p>
          <ul className="recommendations-list">
            {result.recommendations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {error && <p className="error">{error}</p>}
          <div className="actions left">
            <button type="button" onClick={() => setStep(6)}>Back</button>
            <button type="button" onClick={() => downloadCsv(result)}>Download CSV</button>
            <button type="button" className="button primary" onClick={saveToHistory}>
              Save Session
            </button>
          </div>
        </div>
      )}

      {step === 8 && (
        <p className="success">
          Step 8 complete: session saved to history. Open History to review uploads or Compare to stack two runs side by side.
        </p>
      )}
    </section>
  );
}

function HistoryPage() {
  const { clearAllHistory } = useOutletContext<DashboardOutletContext>();
  const [userSessions, setUserSessions] = useState<SavedSession[]>([]);

  useEffect(() => {
    void (async () => {
      const data = await apiGetSessions();
      if (Array.isArray(data)) {
        setUserSessions(data);
      }
    })();
  }, []);

  const onClearAll = () => {
    if (!userSessions.length) return;
    if (!window.confirm("Remove all saved sessions? This cannot be undone.")) return;
    clearAllHistory();
    setUserSessions([]);
  };

  return (
    <section className="panel">
      <h2>Analysis History</h2>
      <p>
        Previously saved analyses ({userSessions.length} session{userSessions.length === 1 ? "" : "s"}).
      </p>
      <div className="actions left history-toolbar">
        <button type="button" className="button danger" onClick={onClearAll} disabled={!userSessions.length}>
          Clear all history
        </button>
      </div>
      {!userSessions.length && (
        <p className="upload-tip">No history yet. Save a session from New Analysis to store it here.</p>
      )}
      <div className="history-grid">
        {userSessions.map((session) => (
          <article key={session.id} className="history-card">
            <img src={session.imageDataUrl} alt="Past upload" />
            <h4>{new Date(session.createdAt).toLocaleString()}</h4>
            <p>Score: {session.result.overallScore}</p>
            <p>Severity: {session.result.severity}</p>
            <p>Primary: {session.result.worstRegion}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ComparePage() {
  const [userSessions, setUserSessions] = useState<SavedSession[]>([]);
  const [idA, setIdA] = useState("");
  const [idB, setIdB] = useState("");

  useEffect(() => {
    void (async () => {
      const data = await apiGetSessions();
      if (Array.isArray(data)) {
        setUserSessions(data);
        if (data.length >= 1) setIdA(data[0].id);
        if (data.length >= 2) setIdB(data[1].id);
      }
    })();
  }, []);

  const sessionA = userSessions.find((s) => s.id === idA);
  const sessionB = userSessions.find((s) => s.id === idB);

  const barData = useMemo(() => {
    if (!sessionA || !sessionB) return [];
    const normA = normalizeScoresForCompare(sessionA.result.scores as Record<string, number>);
    const normB = normalizeScoresForCompare(sessionB.result.scores as Record<string, number>);
    return REGION_KEYS.map((region) => ({
      region,
      A: normA[region],
      B: normB[region],
    }));
  }, [sessionA, sessionB]);

  if (!userSessions.length) {
    return (
      <section className="panel">
        <h2>Compare Sessions</h2>
        <p className="upload-tip">Save at least two sessions to History, then pick two runs to compare.</p>
      </section>
    );
  }

  if (!sessionA || !sessionB) {
    return (
      <section className="panel">
        <h2>Compare Sessions</h2>
        <p>Loading comparison…</p>
      </section>
    );
  }

  const deltaOverall = Number((sessionB.result.overallScore - sessionA.result.overallScore).toFixed(1));
  const deltaIndex = Number((sessionB.result.asymmetryIndex - sessionA.result.asymmetryIndex).toFixed(2));

  return (
    <section className="panel">
      <h2>Compare Sessions</h2>
      <p>Choose two saved sessions to compare scores, regions, and thumbnails side by side.</p>
      <div className="grid two compare-selects">
        <label>
          Session A (baseline)
          <select value={idA} onChange={(e) => setIdA(e.target.value)}>
            {userSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.createdAt).toLocaleString()} — score {s.result.overallScore}
              </option>
            ))}
          </select>
        </label>
        <label>
          Session B (compare)
          <select value={idB} onChange={(e) => setIdB(e.target.value)}>
            {userSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.createdAt).toLocaleString()} — score {s.result.overallScore}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid two compare-thumbs">
        <article className="panel alt">
          <h3>Session A</h3>
          <img src={sessionA.imageDataUrl} alt="Session A" className="compare-thumb" />
          <p>Score: {sessionA.result.overallScore}</p>
          <p>Index: {sessionA.result.asymmetryIndex}%</p>
          <p>Severity: {sessionA.result.severity}</p>
          <p>Primary: {sessionA.result.worstRegion}</p>
        </article>
        <article className="panel alt">
          <h3>Session B</h3>
          <img src={sessionB.imageDataUrl} alt="Session B" className="compare-thumb" />
          <p>Score: {sessionB.result.overallScore}</p>
          <p>Index: {sessionB.result.asymmetryIndex}%</p>
          <p>Severity: {sessionB.result.severity}</p>
          <p>Primary: {sessionB.result.worstRegion}</p>
        </article>
      </div>
      <div className="panel alt compare-deltas">
        <h3>Summary delta (B − A)</h3>
        <p>
          Overall score: <strong>{deltaOverall >= 0 ? "+" : ""}{deltaOverall}</strong> · Asymmetry index:{" "}
          <strong>{deltaIndex >= 0 ? "+" : ""}{deltaIndex}</strong> pts
        </p>
      </div>
      <div className="panel alt">
        <h3>Regional scores</h3>
        <div className="chart-wrap compare-bar-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e6ff" />
              <XAxis dataKey="region" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 1000]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="A" fill="#8b83ff" name="Session A" radius={[4, 4, 0, 0]} />
              <Bar dataKey="B" fill="#5c6bff" name="Session B" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}

function App() {
  const { user, signIn, signUp, signOut, updateProfile } = useAuthState();
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell user={user} onLogout={signOut} />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage onLogin={signIn} />} />
          <Route path="/signup" element={<SignupPage onSignup={signUp} />} />
          <Route
            path="/profile"
            element={
              <ProtectedRoute user={user}>{user ? <ProfilePage user={user} /> : null}</ProtectedRoute>
            }
          />
          <Route
            path="/profile/edit"
            element={
              <ProtectedRoute user={user}>
                {user ? <EditProfilePage user={user} onUpdate={updateProfile} /> : null}
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute user={user}>{user ? <DashboardLayout user={user} /> : null}</ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard/new" replace />} />
            <Route path="new" element={<NewAnalysisPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="compare" element={<ComparePage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
