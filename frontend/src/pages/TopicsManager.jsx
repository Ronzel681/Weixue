import { useState } from 'react';
import useStore from '../stores/gradingStore';
import * as api from '../api/client';

const TYPE_LABEL = { dilemma: '两难抉择', fact_opinion: '事实观点', causal: '因果推导' };
const TIER_LABEL = { basic: '基础层', developing: '发展层', advancing: '进阶层' };
const SOURCE_LABEL = { audio: '🎙️', asr: '📝', manual: '✍️' };

const respStatus = (r) => {
  if (r.teacher_reviewed) return { text: '已批改', cls: 'text-indigo-600 bg-indigo-50' };
  if (r.ai_confidence && r.ai_confidence !== 'uncertain') return { text: 'AI已评', cls: 'text-green-600 bg-green-50' };
  return { text: '待评估', cls: 'text-amber-600 bg-amber-50' };
};

export default function TopicsManager() {
  const { courseId, topics, students, responses, loadCourse } = useStore();
  const [editingId, setEditingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const studentMap = {};
  students.forEach(s => { studentMap[s.id] = s; });

  const countByTopic = {};
  Object.values(responses).forEach(arr => (arr || []).forEach(r => {
    if (r.raw_text && r.raw_text.trim()) countByTopic[r.topic_id] = (countByTopic[r.topic_id] || 0) + 1;
  }));

  const move = async (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= topics.length) return;
    const a = topics[idx];
    const b = topics[target];
    await api.updateTopic(a.id, { order: b.order });
    await api.updateTopic(b.id, { order: a.order });
    await loadCourse(courseId);
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`删除辩题「${t.title}」？相关作答记录也会一并删除。`)) return;
    await api.deleteTopic(t.id);
    await loadCourse(courseId);
  };

  const handleRemoveResponse = async (rid) => {
    if (!window.confirm('移除该学生在此题下的作答？')) return;
    await api.deleteResponse(rid);
    await loadCourse(courseId);
  };

  return (
    <div className="bg-white rounded-xl p-4 border border-slate-200">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-slate-600">辩题列表（{topics.length}）</div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium cursor-pointer hover:bg-indigo-700 transition-colors"
        >
          {showAdd ? '收起' : '＋ 新建辩题'}
        </button>
      </div>
      {showAdd && (
        <TopicForm
          mode="add"
          courseId={courseId}
          onDone={async () => { setShowAdd(false); await loadCourse(courseId); }}
        />
      )}
      <div className="flex flex-col gap-2 mt-2">
        {topics.map((t, i) => (
          <div key={t.id} className="border border-slate-100 rounded-lg">
            {editingId === t.id ? (
              <TopicForm
                mode="edit"
                courseId={courseId}
                topic={t}
                onDone={async () => { setEditingId(null); await loadCourse(courseId); }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div>
                <div className="flex items-center gap-3 px-3 py-2">
                  <div className="flex flex-col gap-0.5 shrink-0">
                    <button
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      className="text-slate-300 hover:text-slate-500 text-[11px] disabled:opacity-30 cursor-pointer"
                    >▲</button>
                    <button
                      onClick={() => move(i, 1)}
                      disabled={i === topics.length - 1}
                      className="text-slate-300 hover:text-slate-500 text-[11px] disabled:opacity-30 cursor-pointer"
                    >▼</button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800">{t.order}. {t.title}</div>
                    <div className="text-[11px] text-slate-400">
                      {TYPE_LABEL[t.topic_type] || t.topic_type} · {TIER_LABEL[t.cognitive_tier] || t.cognitive_tier} · 满分 {t.max_score} · {countByTopic[t.id] || 0} 份作答
                    </div>
                  </div>
                  <button
                    onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                    className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-500 cursor-pointer hover:bg-slate-50"
                  >
                    {expandedId === t.id ? '收起学生 ▴' : '查看学生 ▾'}
                  </button>
                  <button
                    onClick={() => setEditingId(t.id)}
                    className="text-xs px-2.5 py-1 rounded-md border border-slate-200 bg-white text-slate-500 cursor-pointer hover:bg-slate-50"
                  >编辑</button>
                  <button
                    onClick={() => handleDelete(t)}
                    className="text-xs px-2.5 py-1 rounded-md border border-red-200 bg-white text-red-500 cursor-pointer hover:bg-red-50"
                  >删除</button>
                </div>
                {expandedId === t.id && (
                  <div className="mx-3 mb-2 pl-3 border-l-2 border-indigo-100 flex flex-col gap-1.5">
                    {(() => {
                      const rows = [];
                      Object.entries(responses).forEach(([sid, arr]) => {
                        (arr || []).forEach(r => {
                          if (r.topic_id === t.id && r.raw_text && r.raw_text.trim()) rows.push(r);
                        });
                      });
                      if (rows.length === 0) {
                        return <div className="text-xs text-slate-400 py-1.5 text-center">暂无学生作答此题</div>;
                      }
                      return rows.map(r => {
                        const st = studentMap[r.student_id];
                        const s = respStatus(r);
                        return (
                          <div key={r.id} className="flex items-center gap-2 text-xs bg-slate-50 rounded-md px-2.5 py-1.5">
                            <span className="w-28 shrink-0 truncate font-medium">{st ? st.name : `学生#${r.student_id}`}</span>
                            <span className="text-slate-400 w-16 shrink-0">{st ? `${st.grade}年级` : ''}</span>
                            <span className={`px-1.5 py-0.5 rounded ${s.cls}`}>{s.text}</span>
                            <span className="text-slate-400">{SOURCE_LABEL[r.source] || r.source}</span>
                            <button
                              onClick={() => handleRemoveResponse(r.id)}
                              className="ml-auto text-red-400 hover:text-red-600 cursor-pointer"
                            >移除</button>
                          </div>
                        );
                      });
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        {topics.length === 0 && (
          <div className="text-xs text-slate-400 py-6 text-center">暂无辩题，点击右上角「新建辩题」</div>
        )}
      </div>
    </div>
  );
}

function TopicForm({ mode, courseId, topic, onDone, onCancel }) {
  const [title, setTitle] = useState(topic?.title || '');
  const [topic_type, setTopicType] = useState(topic?.topic_type || 'dilemma');
  const [cognitive_tier, setTier] = useState(topic?.cognitive_tier || 'developing');
  const [stimulus_material, setStimulus] = useState(topic?.stimulus_material || '');
  const [reference_arguments, setRefs] = useState((topic?.reference_arguments || []).join('\n'));
  const [max_score, setMaxScore] = useState(topic?.max_score ?? 10);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const payload = {
      title: title.trim(),
      topic_type,
      cognitive_tier,
      stimulus_material: stimulus_material.trim(),
      reference_arguments: reference_arguments.split('\n').map(s => s.trim()).filter(Boolean),
      max_score: parseInt(max_score, 10) || 10,
    };
    if (mode === 'add') await api.createTopic(courseId, payload);
    else await api.updateTopic(topic.id, payload);
    setSaving(false);
    await onDone();
  };

  return (
    <div className="bg-slate-50 rounded-lg border border-slate-200 p-3 mt-2">
      <div className="flex gap-2 mb-2">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="辩题标题"
          className="flex-1 text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-indigo-300"
        />
        <select value={topic_type} onChange={e => setTopicType(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
          <option value="dilemma">两难抉择</option>
          <option value="fact_opinion">事实观点</option>
          <option value="causal">因果推导</option>
        </select>
        <select value={cognitive_tier} onChange={e => setTier(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
          <option value="basic">基础层（1-2年级）</option>
          <option value="developing">发展层（3-5年级）</option>
          <option value="advancing">进阶层（6-7年级）</option>
        </select>
        <input
          value={max_score}
          onChange={e => setMaxScore(e.target.value)}
          type="number" min="1" max="100"
          className="w-16 text-sm border border-slate-200 rounded-lg px-2 py-1.5 outline-none"
          title="满分"
        />
      </div>
      <textarea
        value={stimulus_material}
        onChange={e => setStimulus(e.target.value)}
        placeholder="引导材料（可选）"
        className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 resize-none min-h-[40px] outline-none mb-2"
      />
      <textarea
        value={reference_arguments}
        onChange={e => setRefs(e.target.value)}
        placeholder="参考论据（每行一条）"
        className="w-full text-xs border border-slate-200 rounded-lg px-2.5 py-1.5 resize-none min-h-[48px] outline-none mb-2"
      />
      <div className="flex gap-2 justify-end">
        <button
          onClick={handleSave}
          disabled={saving || !title.trim()}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium cursor-pointer hover:bg-indigo-700 disabled:opacity-40"
        >
          {saving ? '保存中...' : mode === 'add' ? '添加辩题' : '保存修改'}
        </button>
        {mode === 'edit' && onCancel && (
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 cursor-pointer">
            取消
          </button>
        )}
      </div>
    </div>
  );
}
