-- Academic Assignment Tracker schema
-- Run against existing PostgreSQL database

-- Encrypted LMS credentials (one per user per platform)
CREATE TABLE IF NOT EXISTS lms_credentials (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL DEFAULT 'brightspace',
    lms_url VARCHAR(500) NOT NULL,
    encrypted_username TEXT NOT NULL,
    encrypted_password TEXT NOT NULL,
    encryption_iv TEXT NOT NULL,
    encryption_tag TEXT NOT NULL,
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, platform)
);

-- Courses discovered from LMS
CREATE TABLE IF NOT EXISTS tracked_courses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL DEFAULT 'brightspace',
    platform_course_id VARCHAR(255),
    course_name VARCHAR(500) NOT NULL,
    course_code VARCHAR(100),
    term VARCHAR(200),
    course_url TEXT,
    last_crawled_at TIMESTAMP,
    deep_crawled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, platform_course_id)
);

-- Assignments extracted from courses
CREATE TABLE IF NOT EXISTS tracked_assignments (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES tracked_courses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_assignment_id VARCHAR(255),
    title VARCHAR(500) NOT NULL,
    description TEXT,
    due_date TIMESTAMP,
    points_possible DECIMAL(10,2),
    submission_status VARCHAR(50) DEFAULT 'not_submitted',
    grade DECIMAL(10,2),
    rubric_text TEXT,
    assignment_type VARCHAR(100),
    assignment_url TEXT,
    full_instructions TEXT,
    requirements JSONB,
    attachment_names JSONB,
    deep_crawled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(course_id, platform_assignment_id)
);

-- Course materials / module structure
CREATE TABLE IF NOT EXISTS tracked_course_materials (
    id SERIAL PRIMARY KEY,
    course_id INTEGER NOT NULL REFERENCES tracked_courses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_name VARCHAR(500),
    topic_title VARCHAR(500),
    topic_type VARCHAR(100),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Sync history / job tracking
CREATE TABLE IF NOT EXISTS sync_jobs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    courses_found INTEGER DEFAULT 0,
    assignments_found INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_tracked_assignments_user_id ON tracked_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_assignments_due_date ON tracked_assignments(due_date);
CREATE INDEX IF NOT EXISTS idx_tracked_assignments_course_id ON tracked_assignments(course_id);
CREATE INDEX IF NOT EXISTS idx_tracked_courses_user_id ON tracked_courses(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_user_id ON sync_jobs(user_id);
