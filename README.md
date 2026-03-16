# ZoomAid

## Today's Live Class

- Join the class board: `https://3918-2a00-a041-e2cd-dc00-ee96-6bed-1f4e-be92.ngrok-free.app/room/ca22ea`
- Room code: `CA22EA`
- When you join, enter your name for attendance and keep the board open beside Zoom.

This room is set up for today's electronics + vibe coding session. Use it to follow live annotations, open shared links, and keep up with the current objective while class is running.

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
