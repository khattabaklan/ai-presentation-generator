const docx = require('docx');

async function generateDocxBuffer(content) {
  const children = [];

  // Title
  children.push(
    new docx.Paragraph({
      children: [
        new docx.TextRun({
          text: content.title,
          bold: true,
          size: 48,
          font: 'Arial',
        }),
      ],
      spacing: { after: 300 },
      alignment: docx.AlignmentType.CENTER,
    })
  );

  children.push(
    new docx.Paragraph({
      children: [
        new docx.TextRun({
          text: 'Speaker Script',
          size: 28,
          color: '666666',
          font: 'Arial',
        }),
      ],
      spacing: { after: 600 },
      alignment: docx.AlignmentType.CENTER,
    })
  );

  // Horizontal rule
  children.push(
    new docx.Paragraph({
      border: {
        bottom: { color: 'CCCCCC', space: 1, style: docx.BorderStyle.SINGLE, size: 6 },
      },
      spacing: { after: 400 },
    })
  );

  for (const slide of content.slides) {
    // Slide header
    children.push(
      new docx.Paragraph({
        children: [
          new docx.TextRun({
            text: `Slide ${slide.slideNumber}: ${slide.title}`,
            bold: true,
            size: 28,
            font: 'Arial',
          }),
        ],
        spacing: { before: 300, after: 200 },
      })
    );

    // Bullet points
    if (slide.bullets && slide.bullets.length > 0) {
      children.push(
        new docx.Paragraph({
          children: [
            new docx.TextRun({
              text: 'Key Points:',
              bold: true,
              size: 22,
              font: 'Arial',
              color: '555555',
            }),
          ],
          spacing: { after: 100 },
        })
      );

      for (const bullet of slide.bullets) {
        children.push(
          new docx.Paragraph({
            children: [
              new docx.TextRun({
                text: bullet,
                size: 22,
                font: 'Arial',
              }),
            ],
            bullet: { level: 0 },
            spacing: { after: 50 },
          })
        );
      }
    }

    // Speaker notes
    if (slide.speakerNotes) {
      children.push(
        new docx.Paragraph({
          children: [
            new docx.TextRun({
              text: 'Speaker Notes:',
              bold: true,
              size: 22,
              font: 'Arial',
              color: '555555',
            }),
          ],
          spacing: { before: 200, after: 100 },
        })
      );

      children.push(
        new docx.Paragraph({
          children: [
            new docx.TextRun({
              text: slide.speakerNotes,
              size: 22,
              font: 'Arial',
              italics: true,
            }),
          ],
          spacing: { after: 200 },
        })
      );
    }

    // Separator
    children.push(
      new docx.Paragraph({
        border: {
          bottom: { color: 'EEEEEE', space: 1, style: docx.BorderStyle.SINGLE, size: 4 },
        },
        spacing: { after: 200 },
      })
    );
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });

  const buffer = await docx.Packer.toBuffer(doc);
  return buffer;
}

module.exports = { generateDocxBuffer };
