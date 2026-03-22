const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function generatePresentationContent(assignmentText, slideCount = 10, colorTheme = 'professional') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are an expert university presentation creator. Given the following assignment instructions, generate a structured presentation.

ASSIGNMENT INSTRUCTIONS:
${assignmentText}

REQUIREMENTS:
- Create exactly ${slideCount} slides
- Color theme preference: ${colorTheme}
- Include a title slide as slide 1
- Include a conclusion/summary slide as the last slide
- Each slide should have clear, concise bullet points (3-5 per slide)
- Generate detailed speaker notes for each slide (2-4 sentences per slide)

Respond with ONLY valid JSON in this exact format:
{
  "title": "Presentation Title",
  "slides": [
    {
      "slideNumber": 1,
      "title": "Slide Title",
      "bullets": ["Bullet point 1", "Bullet point 2", "Bullet point 3"],
      "speakerNotes": "Detailed speaker notes for this slide..."
    }
  ]
}`,
      },
    ],
  });

  const text = response.content[0].text;

  // Extract JSON from the response (handle potential markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse presentation content from Claude response');
  }

  const content = JSON.parse(jsonMatch[0]);

  if (!content.title || !Array.isArray(content.slides) || content.slides.length === 0) {
    throw new Error('Invalid presentation structure returned from Claude');
  }

  return content;
}

// ─── Page Content Parsing (Deep Crawl) ──────────────────────────────────────

const PAGE_PROMPTS = {
  courses: (text) => `You are extracting course information from a Brightspace LMS homepage.

PAGE TEXT:
${text}

Extract ALL courses the student is enrolled in. For each course, extract:
- courseId: the numeric ID from any /d2l/home/{ID} URL
- name: the full course name
- code: the course code if visible (e.g., "CIS 2750", "BIOL-2301")

Respond with ONLY valid JSON:
{"courses": [{"courseId": "12345", "name": "Introduction to Computing", "code": "CIS 1500"}]}

If no courses found, return {"courses": []}.`,

  assignments_list: (text, courseId) => `You are extracting assignments from a Brightspace LMS dropbox/assignments page for course ${courseId}.

PAGE TEXT:
${text}

Extract ALL assignments visible. For each one:
- title: assignment name
- dueDate: due date in ISO 8601 if visible, null otherwise
- points: total points possible (number), null if not shown
- status: "not_submitted", "submitted", or "graded"
- detailUrl: the relative URL to the assignment detail page (contains "dropbox" or "folder" with db= or fid= parameter)
- assignmentId: numeric ID from the URL (db= or fid= parameter)

Respond with ONLY valid JSON:
{"assignments": [{"title": "...", "dueDate": null, "points": null, "status": "not_submitted", "detailUrl": "/d2l/...", "assignmentId": "12345"}]}`,

  assignment_detail: (text) => `You are extracting the FULL content of a university assignment from its Brightspace detail page.

PAGE TEXT:
${text}

Extract everything a student needs to complete this assignment:

1. fullInstructions: The COMPLETE assignment instructions. Preserve all details, requirements, sections, numbered lists.
2. rubric: If grading criteria or a rubric is visible, extract it showing categories, descriptions, and point values.
3. requirements: Concise bullet-point list of deliverables (e.g., "2000-word essay", "10-slide presentation", "5 peer-reviewed sources").
4. attachments: File names of any attachments mentioned (e.g., "template.docx", "rubric.pdf").
5. wordCount: Word/page count requirement if mentioned.
6. formatRequirements: Formatting requirements (APA, MLA, font, spacing, etc).

Respond with ONLY valid JSON:
{
  "fullInstructions": "Complete text...",
  "rubric": "Rubric text or null",
  "requirements": ["Req 1", "Req 2"],
  "attachments": ["file.docx"],
  "wordCount": "2000 words",
  "formatRequirements": "APA 7th edition"
}`,

  quizzes: (text, courseId) => `You are extracting quiz information from a Brightspace LMS quizzes page for course ${courseId}.

PAGE TEXT:
${text}

Extract ALL quizzes visible:
- title: quiz name
- dueDate: due/end date in ISO 8601 if visible, null otherwise
- timeLimit: time limit if shown (e.g., "60 minutes")
- attempts: allowed attempts if shown
- status: "not_attempted", "completed", or "in_progress"
- quizId: numeric ID from URL (qu= parameter)

Respond with ONLY valid JSON:
{"quizzes": [{"title": "...", "dueDate": null, "timeLimit": null, "attempts": null, "status": "not_attempted", "quizId": "789"}]}`,

  course_content: (text, courseId) => `You are extracting course content/module structure from a Brightspace content page for course ${courseId}.

PAGE TEXT:
${text}

Extract the module and topic structure:
- Each module has a name and contains topics
- Topics can be lectures, readings, files, links, or videos

Respond with ONLY valid JSON:
{"materials": [{"moduleName": "Week 1: Introduction", "topics": [{"title": "Lecture Slides", "type": "file"}, {"title": "Chapter 1", "type": "reading"}]}]}

If no content found, return {"materials": []}.`,
};

async function parsePageContent(pageText, pageType, courseId) {
  const promptFn = PAGE_PROMPTS[pageType];
  if (!promptFn) throw new Error(`Unknown page type: ${pageType}`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: promptFn(pageText, courseId),
      },
    ],
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse structured data from Claude response');
  }

  return JSON.parse(jsonMatch[0]);
}

module.exports = { generatePresentationContent, parsePageContent };
