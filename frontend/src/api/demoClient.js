/**
 * Demo API client — returns data from embedded JSON, no backend needed.
 * Used when VITE_DEMO_MODE=true (e.g. GitHub Pages deployment).
 *
 * Key: demo-data.json is exported directly from SQLite, where JSON fields
 * are stored as TEXT strings. The backend normally parses these via Pydantic,
 * so we must parse them here before returning to the frontend.
 */
import demoData from '../demo-data.json';

const _clone = (v) => JSON.parse(JSON.stringify(v));
const _pristine = demoData;
let _data = _clone(demoData);
const ok = (d) => Promise.resolve(d);

// Demo transcript used by the simulated audio import (matches the 动物园 topics).
const DEMO_TRANSCRIPT =
  '我觉得应该把老鹰放回野外。因为老鹰本来就是天空的动物，关在动物园里就只能走来走去，很不自由。' +
  '我同意它康复后放走，但是要确认它真的能自己抓食物再放，不然它又会受伤。';

// ── JSON field parsers ──────────────────────────────────

function _jp(val) {
  if (!val) return val;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch { return val; }
}

function _parseResponse(r) {
  if (!r) return r;
  return {
    ...r,
    ai_dimension_scores: _jp(r.ai_dimension_scores),
    teacher_dimension_scores: _jp(r.teacher_dimension_scores),
    ai_reasoning: _jp(r.ai_reasoning),
    ai_extracted_features: _jp(r.ai_extracted_features),
    ai_suggested_tags: _jp(r.ai_suggested_tags),
    teacher_tags: _jp(r.teacher_tags),
  };
}

function _parseTopic(t) {
  if (!t) return t;
  return { ...t, reference_arguments: _jp(t.reference_arguments) };
}

function _parseCalibration(c) {
  if (!c) return c;
  return {
    ...c,
    ai_original_scores: _jp(c.ai_original_scores),
    teacher_final_scores: _jp(c.teacher_final_scores),
    modifications: _jp(c.modifications),
  };
}

function _parseTag(t) {
  if (!t) return t;
  return { ...t, topic_ids: _jp(t.topic_ids) };
}

// ── Courses ─────────────────────────────────────────────
export const getCourses = () => ok(_data.courses);
export const getCourse = (cid) => ok(_data.courses.find(c => c.id === cid));
export const createCourse = (data) => {
  const id = Math.max(0, ..._data.courses.map(c => c.id)) + 1;
  const c = { id, ...data, created_at: new Date().toISOString(), topic_count: 0, student_count: 0 };
  _data.courses.push(c);
  return ok(c);
};

// ── Topics ──────────────────────────────────────────────
export const getTopics = (cid) =>
  ok(_data.topics.filter(t => t.course_id === cid).map(_parseTopic));
export const createTopic = (cid, data) => {
  const courseTopics = _data.topics.filter(t => t.course_id === cid);
  const order = courseTopics.length ? Math.max(...courseTopics.map(t => t.order)) + 1 : 1;
  const t = {
    id: Math.max(0, ..._data.topics.map(x => x.id)) + 1,
    course_id: cid,
    order,
    rubric_template_id: null,
    ...data,
  };
  _data.topics.push(t);
  return ok(t);
};
export const updateTopic = (tid, data) => {
  const t = _data.topics.find(x => x.id === tid);
  if (t) Object.assign(t, data);
  return ok(t);
};
export const deleteTopic = (tid) => {
  _data.topics = _data.topics.filter(x => x.id !== tid);
  _data.responses = _data.responses.filter(r => r.topic_id !== tid);
  return ok({ ok: true, topic_id: tid });
};

// ── Students ────────────────────────────────────────────
export const getStudents = (cid) => ok(_data.students.filter(s => s.course_id === cid));
export const createStudentsBatch = (cid, students) => {
  const created = [];
  let nextId = Math.max(0, ..._data.students.map(s => s.id)) + 1;
  students.forEach(s => {
    if (_data.students.some(x => x.course_id === cid && x.name === s.name)) return;
    const st = { id: nextId++, course_id: cid, name: s.name, grade: s.grade, comment_draft: '' };
    _data.students.push(st);
    created.push(st);
  });
  return ok({ created, skipped: [] });
};
export const updateStudent = (sid, data) => {
  const s = _data.students.find(x => x.id === sid);
  if (s) Object.assign(s, data);
  return ok(s);
};
export const deleteStudent = (sid) => {
  _data.students = _data.students.filter(x => x.id !== sid);
  _data.responses = _data.responses.filter(r => r.student_id !== sid);
  return ok({ ok: true, student_id: sid });
};

// ── Responses ───────────────────────────────────────────
export const getResponses = (cid, studentId) => {
  let resps = _data.responses.map(_parseResponse);
  if (studentId) resps = resps.filter(r => r.student_id === studentId);
  return ok(resps);
};

export const getResponse = (rid) =>
  ok(_parseResponse(_data.responses.find(r => r.id === rid)));

export const deleteResponse = (rid) => {
  _data.responses = _data.responses.filter(r => r.id !== rid);
  return ok({ ok: true, response_id: rid });
};

export const reviewResponse = (rid, data) => {
  const resp = _data.responses.find(r => r.id === rid);
  if (resp) {
    resp.teacher_dimension_scores = data.dimension_scores || null;
    resp.teacher_confidence_override = data.confidence_override || null;
    resp.teacher_tags = data.tags || [];
    resp.teacher_note = data.note || '';
    resp.teacher_reviewed = true;
  }
  return ok(_parseResponse(resp));
};

export const importAudio = (cid, studentId, topicId, file) => {
  const resp = _data.responses.find(
    r => r.student_id === studentId && r.topic_id === topicId
  );
  if (resp) {
    resp.raw_text = DEMO_TRANSCRIPT;
    resp.source = 'audio';
    resp.cleaned_text = '';
    resp.ai_dimension_scores = null;
    resp.ai_confidence = 'uncertain';
    resp.teacher_reviewed = false;
  }
  return ok(_parseResponse(resp));
};
export const importText = (cid, studentId, topicId, text) => {
  let resp = _data.responses.find(r => r.student_id === studentId && r.topic_id === topicId);
  if (!resp) {
    resp = { id: Math.max(0, ..._data.responses.map(r => r.id)) + 1, student_id: studentId, topic_id: topicId };
    _data.responses.push(resp);
  }
  resp.raw_text = text;
  resp.source = 'manual';
  resp.cleaned_text = '';
  resp.ai_dimension_scores = null;
  resp.ai_confidence = 'uncertain';
  resp.teacher_reviewed = false;
  return ok(_parseResponse(resp));
};

// ── Assessment (no-op in demo) ──────────────────────────
export const assessCourse = (cid) => ok({ assessed: 0, skipped: 0 });
export const getAssessmentProgress = (cid) =>
  ok({
    completed: _data.responses.length,
    total: _data.responses.length,
    active: false,
    llm_calls: 0,
    skipped: 0,
    errors: 0,
  });
export const resetCourse = (cid) => {
  _data = _clone(_pristine);
  return ok({ ok: true });
};

// ── Comments ────────────────────────────────────────────
export const generateComment = (cid, studentId) => {
  const s = _data.students.find(s => s.id === studentId);
  return ok({ student_id: studentId, draft: s?.comment_draft || '' });
};
export const saveCommentDraft = (cid, studentId, draft) => {
  const s = _data.students.find(s => s.id === studentId);
  if (s) s.comment_draft = draft;
  return ok({ ok: true });
};
export const batchGenerateComments = (cid) => {
  const results = _data.students
    .filter(s => s.course_id === cid && s.comment_draft)
    .map(s => ({ student_id: s.id, student_name: s.name, draft: s.comment_draft, error: null }));
  return ok({ results });
};

// ── Prep Analytics (simplified) ─────────────────────────
export const getPrepAnalytics = (cid) => ok([]);

// ── Report (simplified) ─────────────────────────────────
export const getClassReport = (cid) => {
  const ratingMap = { A: 4, 'A+': 4, 'B+': 3.5, B: 3, 'C+': 2.5, C: 2, D: 1 };
  const students = _data.students;
  const responses = _data.responses.map(_parseResponse);

  const studentStats = students.map(st => {
    const vals = [];
    responses.filter(r => r.student_id === st.id).forEach(r => {
      const scores = r.teacher_dimension_scores || r.ai_dimension_scores;
      if (scores && typeof scores === 'object') {
        Object.values(scores).forEach(rating => {
          vals.push(ratingMap[rating] || 2);
        });
      }
    });
    return {
      student_id: st.id, name: st.name, grade: st.grade,
      avg_score: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0,
      uncertain: 0,
    };
  });

  const avgs = studentStats.map(s => s.avg_score).filter(a => a > 0);
  return ok({
    class_avg: avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 100) / 100 : 0,
    student_count: students.length,
    topic_stats: [],
    student_stats: studentStats,
    top_tags: _data.tags.slice(0, 10).map(t => ({ name: t.name, count: t.use_count, source: t.source })),
  });
};

// ── Tags ────────────────────────────────────────────────
export const getTags = (cid) =>
  ok(_data.tags.filter(t => t.course_id === cid).map(_parseTag));
export const createTag = (cid, name, source) => ok({ id: 999, name, source, use_count: 0 });
export const updateTag = (tid, data) => ok({ id: tid, ...data });
export const mergeTags = (keepId, mergeIds) => ok({ id: keepId });
export const deleteTag = (tid) => ok({ ok: true });

// ── Calibrations ────────────────────────────────────────
export const getCalibrations = (cid) =>
  ok((_data.calibrations || []).map(_parseCalibration));
