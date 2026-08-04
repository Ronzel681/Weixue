import { useState } from 'react';
import TopicsManager from './TopicsManager';
import StudentsManager from './StudentsManager';
import RecordingsManager from './RecordingsManager';

const SUB_TABS = [
  { key: 'topics', label: '辩题管理', icon: '📝' },
  { key: 'students', label: '学生管理', icon: '👥' },
  { key: 'recordings', label: '录音录入', icon: '🎙️' },
];

/* 管理大页：辩题 / 学生 / 录音三个独立子页，互不干扰。 */
export default function ManagementPage() {
  const [sub, setSub] = useState('topics');
  return (
    <div className="flex flex-col gap-4">
      <nav className="bg-white rounded-xl border border-slate-200 p-1 flex gap-1 w-fit">
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setSub(t.key)}
            className={`px-4 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer
              ${sub === t.key ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </nav>
      {sub === 'topics' && <TopicsManager />}
      {sub === 'students' && <StudentsManager />}
      {sub === 'recordings' && <RecordingsManager />}
    </div>
  );
}
