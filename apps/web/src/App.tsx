import { Route, Routes } from 'react-router-dom';

import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AdminPage } from './routes/AdminPage';
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
import { WebhookSubscriptionsPage } from './routes/WebhookSubscriptionsPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="layouts/:slug" element={<LayoutDetailPage />} />
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
          path="moderation/webhooks"
          element={
            <RequireAuth role="moderator">
              <WebhookSubscriptionsPage />
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
