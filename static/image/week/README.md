# Week photos (optional)

Drop seven images here and the landing page's right-hand frame will cross-fade
through them as the visitor scrolls the week:

    mon.jpg  tue.jpg  wed.jpg  thu.jpg  fri.jpg  sat.jpg  sun.jpg

Any file that is missing removes its own `<img>` on error, leaving the labelled
placeholder ("MONDAY", "TUESDAY", ...) showing. The page works with none, some,
or all seven present — nothing breaks.

Landscape crops work best; the frame uses `object-fit: cover`.
