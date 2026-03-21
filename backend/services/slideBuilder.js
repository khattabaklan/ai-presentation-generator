const PptxGenJS = require('pptxgenjs');

const COLOR_THEMES = {
  professional: {
    background: 'FFFFFF',
    titleColor: '1B2A4A',
    textColor: '333333',
    accentColor: '2E86AB',
    bulletColor: '2E86AB',
  },
  modern: {
    background: 'F5F5F5',
    titleColor: '2D3436',
    textColor: '636E72',
    accentColor: 'E17055',
    bulletColor: 'E17055',
  },
  academic: {
    background: 'FFFEF7',
    titleColor: '8B0000',
    textColor: '2C3E50',
    accentColor: '8B0000',
    bulletColor: 'B22222',
  },
  dark: {
    background: '1A1A2E',
    titleColor: 'E94560',
    textColor: 'EAEAEA',
    accentColor: 'E94560',
    bulletColor: '0F3460',
  },
  nature: {
    background: 'F0F4E8',
    titleColor: '2D572C',
    textColor: '3E3E3E',
    accentColor: '4CAF50',
    bulletColor: '2D572C',
  },
};

function buildPresentation(content, themeName = 'professional') {
  const theme = COLOR_THEMES[themeName] || COLOR_THEMES.professional;
  const pptx = new PptxGenJS();

  pptx.title = content.title;
  pptx.author = 'AI Presentation Generator';
  pptx.layout = 'LAYOUT_WIDE';

  for (const slide of content.slides) {
    const s = pptx.addSlide();
    s.background = { color: theme.background };

    if (slide.slideNumber === 1) {
      // Title slide
      s.addText(slide.title, {
        x: 0.5,
        y: 1.5,
        w: '90%',
        h: 2,
        fontSize: 36,
        bold: true,
        color: theme.titleColor,
        align: 'center',
        fontFace: 'Arial',
      });

      if (slide.bullets && slide.bullets.length > 0) {
        s.addText(slide.bullets[0], {
          x: 0.5,
          y: 3.8,
          w: '90%',
          h: 1,
          fontSize: 18,
          color: theme.textColor,
          align: 'center',
          fontFace: 'Arial',
        });
      }
    } else {
      // Content slides
      s.addText(slide.title, {
        x: 0.5,
        y: 0.3,
        w: '90%',
        h: 0.8,
        fontSize: 28,
        bold: true,
        color: theme.titleColor,
        fontFace: 'Arial',
      });

      // Accent line under title
      s.addShape(pptx.ShapeType.rect, {
        x: 0.5,
        y: 1.1,
        w: 2,
        h: 0.04,
        fill: { color: theme.accentColor },
      });

      if (slide.bullets && slide.bullets.length > 0) {
        const bulletText = slide.bullets.map((b) => ({
          text: b,
          options: {
            fontSize: 18,
            color: theme.textColor,
            fontFace: 'Arial',
            bullet: { color: theme.bulletColor },
            paraSpaceAfter: 12,
          },
        }));

        s.addText(bulletText, {
          x: 0.8,
          y: 1.4,
          w: '85%',
          h: 4.5,
          valign: 'top',
        });
      }
    }

    // Add speaker notes
    if (slide.speakerNotes) {
      s.addNotes(slide.speakerNotes);
    }
  }

  return pptx;
}

async function generatePptxBuffer(content, themeName) {
  const pptx = buildPresentation(content, themeName);
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

module.exports = { generatePptxBuffer };
