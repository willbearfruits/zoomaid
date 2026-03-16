# ZoomAid

ZoomAid is a lightweight realtime classroom board for Zoom lessons. It gives you:

- A shareable live canvas for sketches and whiteboard notes
- An annotatable screen relay that sits under the whiteboard strokes
- A live resources panel for repos, datasheets, docs, and assignments
- A session board for topic, objective, prompt, and checklist items
- QR-based room sharing for students
- Basic attendance sign-in so you can see who is present
- A simple timer to keep build sprints aligned
- A low-frame screen relay for code windows, schematics, or document-camera style previews

## Run

```bash
npm start
```

Open `http://localhost:3000`, create a room, and share the student link.

## Notes

- Room state is stored in memory, so restarting the server clears active rooms.
- Students can sign in from their room view; attendance updates appear in the teacher console.
- When screen relay is active, the board acts as an annotation layer over the latest screen frame.
- The screen relay is meant as a lightweight preview. Keep Zoom screen sharing for full-motion demos.
