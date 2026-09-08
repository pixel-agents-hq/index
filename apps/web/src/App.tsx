import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AdminPage } from './routes/AdminPage';
import { AssetDetailPage } from './routes/AssetDetailPage';
import { AssetsGallery } from './routes/AssetsGallery';
import { AssetSubmitPage } from './routes/AssetSubmitPage';
import { AuditLogPage } from './routes/AuditLogPage';
import { AuthorPage } from './routes/AuthorPage';
import { DeveloperPage } from './routes/DeveloperPage';
import { Home } from './routes/Home';
import { LayoutDetailPage } from './routes/LayoutDetailPage';
import { LayoutEditorPage } from './routes/LayoutEditorPage';
import { ModerationPage } from './routes/ModerationPage';
import { MyLayoutsPage } from './routes/MyLayoutsPage';
import { NotFound } from './routes/NotFound';
import { SubmitPage } from './routes/SubmitPage';

/**
 * `<Navigate to="/layouts/" replace>` alone drops the URL's hash: `replace`
 * becomes a real `history.replaceState(..., '/layouts/')`, and a browser
 * clears any fragment the new URL string doesn't repeat. Discord's OAuth
 * callback lands the browser back at the site root carrying exactly that —
 * `#pixelIndexLoginCode=...` — and `AuthProvider`'s own effect (a descendant
 * of this route, so its passive effects flush after this one's) reads
 * `location.hash` too late, after this redirect already erased it. Carrying
 * the current hash forward is what stops login silently degrading to
 * "anonymous" every time it lands on the root path.
 */
function RootRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: '/layouts/', hash: location.hash }} replace />;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* #101: the root gallery moved to /layouts/ to make room for /assets/. */}
        <Route index element={<RootRedirect />} />
        <Route path="layouts" element={<Home />} />
        <Route path="layouts/:slug" element={<LayoutDetailPage />} />
        {/* #101: custom-asset browsing/detail/upload, mirroring the layout routes above. */}
        <Route path="assets" element={<AssetsGallery />} />
        <Route path="assets/submit" element={<AssetSubmitPage />} />
        <Route path="assets/:id" element={<AssetDetailPage />} />
        {/*
          Both editor routes render the same page — the difference is only
          where the layout comes from and where it goes (#65). The gate is
          inside it, like /submit's, because the capability being checked is
          "may submit layouts", not "is logged in".
        */}
        <Route path="editor" element={<LayoutEditorPage />} />
        <Route path="layouts/:slug/edit" element={<LayoutEditorPage />} />
        <Route path="authors/:id" element={<AuthorPage />} />
        <Route path="submit" element={<SubmitPage />} />
        <Route path="developer" element={<DeveloperPage />} />
        <Route
          path="me/layouts"
          element={
            <RequireAuth>
              <MyLayoutsPage />
            </RequireAuth>
          }
        />
        <Route
          path="moderation"
          element={
            <RequireAuth role="moderator">
              <ModerationPage />
            </RequireAuth>
          }
        />
        <Route
          path="admin"
          element={
            <RequireAuth role="admin">
              <AdminPage />
            </RequireAuth>
          }
        />
        <Route
          path="admin/history"
          element={
            <RequireAuth role="admin">
              <AuditLogPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
