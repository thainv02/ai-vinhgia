import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { toast } from '../lib/toast';
import { ClipEnvProvider } from '../clips/env';
import { appClipEnv } from '../clips/appIo';
import { ClipWorkspace } from '../clips/ClipWorkspace';

/** `/clips/:id`: trang làm việc của một dự án cắt clip. */
export default function ClipProjectPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <ClipEnvProvider value={appClipEnv}>
      <ClipWorkspace
        key={id}
        projectId={id}
        back={
          <Link to="/clips" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg">
            <Icon name="arrowLeft" size={14} /> Cắt clip
          </Link>
        }
        onDeleted={() => {
          toast.success('Đã chuyển dự án vào thùng rác. Khôi phục ở mục Thùng rác trong 30 ngày.');
          void qc.invalidateQueries();
          navigate('/clips');
        }}
      />
    </ClipEnvProvider>
  );
}
