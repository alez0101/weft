---
title: Your own model key
parent: Weft help
summary: Using your own Anthropic or OpenAI key for your questions, if your admin allows it.
---
If your admin allows it, you can use your own Anthropic or OpenAI key for your questions to Weft. Open the menu on your initial (top right) and choose **Your model key**.

### Setting it up

1. Choose **Anthropic** or **OpenAI** and type the model name (for example `claude-opus-5-5`).
2. Press **Save**, then paste your key under **API key** and press **Save key**.
3. Press **Test connection** to check it.

Add the provider's prices per million tokens if you want Weft to track what your key has spent this month, and a monthly cap if you want it to stop there.

### How it is used

- Only for **your** questions: in your Weft conversation, and when you @Weft in a channel. Nobody else's questions ever use it.
- Your key answers first. If it fails (a rejected key, a provider outage, or your cap reached), Weft's own models answer instead, and the note under the answer says why.
- The note under each answer says when it was answered with your own key.
- In a channel, an answer still uses only that channel's content, whoever's key wrote it.

### Who can see it

Nobody: your key is encrypted as soon as it is saved, and the screen only ever shows its last four characters, to you. Admins see only how many people have a key, not whose or which.

### Turning it off

Untick **Use my key**, or press **Take off my key** to delete it. If your admin turns personal keys off, your key stays saved but is not used.
