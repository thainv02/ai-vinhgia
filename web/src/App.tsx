import { Route, Routes, Link } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState } from './components/States';
import { LinkButton } from './components/Button';
import ProjectListPage from './pages/ProjectListPage';
import NewProjectPage from './pages/NewProjectPage';
import BoardPage from './pages/BoardPage';
import SceneDetailPage from './pages/SceneDetailPage';
import QueuePage from './pages/QueuePage';
import LedgerPage from './pages/LedgerPage';
import FinalPage from './pages/FinalPage';
import { LiveUpdates } from './hooks/useSSE';

function NotFound() {
  return (
    <EmptyState
      icon="alert"
      title="Không tìm thấy trang"
      action={
        <LinkButton to="/" variant="primary">
          Về danh sách dự án
        </LinkButton>
      }
    >
      Đường dẫn này không tồn tại. <Link to="/" className="underline">Quay lại trang chính</Link>.
    </EmptyState>
  );
}

export default function App() {
  return (
    <LiveUpdates>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<ProjectListPage />} />
          <Route path="/projects/new" element={<NewProjectPage />} />
          <Route path="/projects/:projectId" element={<BoardPage />} />
          <Route path="/projects/:projectId/scenes/:sceneId" element={<SceneDetailPage />} />
          <Route path="/projects/:projectId/ledger" element={<LedgerPage />} />
          <Route path="/projects/:projectId/final" element={<FinalPage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LiveUpdates>
  );
}
