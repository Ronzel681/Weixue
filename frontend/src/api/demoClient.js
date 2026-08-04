/**
 * Demo API client — returns data from embedded JSON, no backend needed.
 * Used when VITE_DEMO_MODE=true (e.g. GitHub Pages deployment).
 *
 * Key: demo-data.json is exported directly from SQLite, where JSON fields
 * are stored as TEXT strings. The backend normally parses these via Pydantic,
 * so we must parse them here before returning to the frontend.
 */
import demoData from '../demo-data.json';
import { ratingToNumber } from '../utils/ratings';

const _clone = (v) => JSON.parse(JSON.stringify(v));
const _pristine = demoData;
let _data = _clone(demoData);
const ok = (d) => Promise.resolve(d);

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

// ── Topics ──────────────────────────────────────────────
export const getTopics = (cid) =>
  ok(_data.topics.filter(t => t.course_id === cid).map(_parseTopic));

// ── Students ────────────────────────────────────────────
export const getStudents = (cid) => ok(_data.students.filter(s => s.course_id === cid));

// ── Responses ───────────────────────────────────────────
export const getResponses = (cid, studentId) => {
  const studentIds = new Set(
    _data.students.filter(student => student.course_id === cid).map(student => student.id),
  );
  let resps = _data.responses.map(_parseResponse).filter(response => studentIds.has(response.student_id));
  if (studentId) resps = resps.filter(r => r.student_id === studentId);
  return ok(resps);
};

export const getResponse = (rid) =>
  ok(_parseResponse(_data.responses.find(r => r.id === rid)));

export const reviewResponse = (rid, data) => {
  const response = _data.responses.find(r => r.id === rid);
  if (!response) return Promise.reject(new Error('Response not found'));
  response.teacher_dimension_scores = data.dimension_scores || null;
  response.teacher_tags = data.tags || [];
  response.teacher_note = data.note || '';
  response.teacher_confidence_override = data.confidence_override || null;
  response.teacher_reviewed = true;
  return ok(_parseResponse(response));
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
  const student = _data.students.find(s => s.id === studentId && s.course_id === cid);
  if (!student) return Promise.reject(new Error('Student not found'));
  student.comment_draft = draft;
  return ok({ ok: true, student_id: studentId });
};
export const sendComment = (cid, studentId, draft) => {
  const student = _data.students.find(s => s.id === studentId && s.course_id === cid);
  if (!student) return Promise.reject(new Error('Student not found'));
  student.comment_draft = draft;
  return ok({
    ok: true,
    student_id: studentId,
    status: 'saved_pending_delivery',
    message: '评语已保存并标记待发送；飞书机器人发送通道将在后续联调中接入。',
  });
};
export const batchGenerateComments = (cid) => ok({
  results: _data.students
    .filter(student => student.course_id === cid)
    .map(student => ({
      student_id: student.id,
      student_name: student.name,
      draft: student.comment_draft || '',
      error: null,
    })),
});

// ── Prep Analytics ──────────────────────────────────────
export const getPrepAnalytics = (cid) => {
  const topics = _data.topics.filter(topic => topic.course_id === cid).map(_parseTopic);
  const students = _data.students.filter(student => student.course_id === cid);
  const studentNames = new Map(students.map(student => [student.id, student.name]));
  const studentIds = new Set(studentNames.keys());
  const responses = _data.responses
    .map(_parseResponse)
    .filter(response => studentIds.has(response.student_id));

  const result = topics.map(topic => {
    const dimensionValues = {};
    const lowStudents = [];
    const tagCounts = {};

    responses.filter(response => response.topic_id === topic.id).forEach(response => {
      const scores = response.teacher_dimension_scores || response.ai_dimension_scores;
      const confidence = response.teacher_confidence_override || response.ai_confidence;
      if (confidence === 'uncertain' && !response.teacher_dimension_scores) return;

      const studentValues = [];
      if (scores && typeof scores === 'object') {
        Object.entries(scores).forEach(([dimension, rating]) => {
          const value = ratingToNumber(rating);
          if (value === null) return;
          (dimensionValues[dimension] ||= []).push(value);
          studentValues.push(value);
        });
      }
      if (studentValues.length > 0) {
        const average = studentValues.reduce((sum, value) => sum + value, 0) / studentValues.length;
        if (average < 2.5) lowStudents.push(`${studentNames.get(response.student_id)}(${average.toFixed(1)})`);
      }

      const tags = response.teacher_tags || response.ai_suggested_tags || [];
      tags.forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; });
    });

    const avgDimensionScores = Object.fromEntries(
      Object.entries(dimensionValues).map(([dimension, values]) => [
        dimension,
        Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
      ]),
    );
    return {
      topic_id: topic.id,
      title: topic.title,
      topic_type: topic.topic_type,
      cognitive_tier: topic.cognitive_tier,
      avg_dimension_scores: avgDimensionScores,
      weak_dimensions: Object.entries(avgDimensionScores)
        .filter(([, average]) => average < 2.5)
        .map(([dimension]) => dimension),
      low_students: lowStudents,
      error_tags: Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([tag, count]) => ({ tag, count })),
    };
  });

  result.sort((a, b) => {
    const aMin = Math.min(...Object.values(a.avg_dimension_scores), 5);
    const bMin = Math.min(...Object.values(b.avg_dimension_scores), 5);
    return aMin - bMin;
  });
  return ok(result);
};

// ── Report ──────────────────────────────────────────────
export const getClassReport = (cid) => {
  const students = _data.students.filter(student => student.course_id === cid);
  const studentIds = new Set(students.map(student => student.id));
  const topics = _data.topics.filter(topic => topic.course_id === cid).map(_parseTopic);
  const responses = _data.responses.map(_parseResponse).filter(response => studentIds.has(response.student_id));

  const topicStats = topics.map(topic => {
    const dimensionValues = {};
    let uncertain = 0;
    responses.filter(response => response.topic_id === topic.id).forEach(response => {
      const scores = response.teacher_dimension_scores || response.ai_dimension_scores;
      const confidence = response.teacher_confidence_override || response.ai_confidence;
      if (confidence === 'uncertain' && !response.teacher_dimension_scores) {
        uncertain += 1;
        return;
      }
      if (!scores || typeof scores !== 'object') return;
      Object.entries(scores).forEach(([dimension, rating]) => {
        const value = ratingToNumber(rating);
        if (value !== null) (dimensionValues[dimension] ||= []).push(value);
      });
    });
    return {
      topic_id: topic.id,
      title: topic.title,
      cognitive_tier: topic.cognitive_tier,
      avg_dimension_scores: Object.fromEntries(
        Object.entries(dimensionValues).map(([dimension, values]) => [
          dimension,
          Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
        ]),
      ),
      uncertain,
    };
  });

  const studentStats = students.map(st => {
    const vals = [];
    let uncertain = 0;
    responses.filter(r => r.student_id === st.id).forEach(r => {
      const scores = r.teacher_dimension_scores || r.ai_dimension_scores;
      const confidence = r.teacher_confidence_override || r.ai_confidence;
      if (confidence === 'uncertain' && !r.teacher_dimension_scores) {
        uncertain += 1;
        return;
      }
      if (scores && typeof scores === 'object') {
        Object.values(scores).forEach(rating => {
          const value = ratingToNumber(rating);
          if (value !== null) vals.push(value);
        });
      }
    });
    return {
      student_id: st.id, name: st.name, grade: st.grade,
      cognitive_tier: st.grade <= 2 ? 'basic' : st.grade <= 5 ? 'developing' : 'advancing',
      avg_score: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : 0,
      uncertain,
    };
  });

  const avgs = studentStats.map(s => s.avg_score).filter(a => a > 0);
  return ok({
    class_avg: avgs.length ? Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 100) / 100 : 0,
    student_count: students.length,
    topic_stats: topicStats,
    student_stats: studentStats,
    top_tags: _data.tags
      .filter(tag => tag.course_id === cid && tag.use_count > 0)
      .sort((a, b) => b.use_count - a.use_count)
      .slice(0, 10)
      .map(tag => ({ name: tag.name, count: tag.use_count, source: tag.source })),
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
