# Drone survey best practices

## Flight planning for mapping
Fly a nadir (camera straight down) grid at a constant height above ground;
30 to 60 m gives a ground sample distance of roughly 1 to 2 cm with a DJI
Mavic 3 Multispectral class camera, and a 12 m (40 ft) flight gives under
1 cm but many more images. Use at least 75 % forward and 70 % side overlap;
for crops with repetitive texture 80 % / 75 % makes photogrammetry far more
reliable. Keep the same height, overlap and flight direction on every date so
surveys can be compared.

## Light and timing
Fly within about two hours of solar noon, under either fully clear or evenly
overcast skies; broken cloud changes the brightness from one image to the
next and shifts every index. Avoid low sun angles that cast long shadows down
the rows. Wind above about 30 km/h (20 mph) moves the canopy between overlapping
photos and blurs the reconstruction.

## Positioning accuracy
RTK or PPK positioning gives image positions at a few centimetres, which is
what makes direct georeferencing and change detection between flights
trustworthy. Without RTK, expect several metres of offset and add ground
control points if precise placement matters. Check the fix quality reported
per image before relying on the positions.

## Multispectral flights
Photograph the calibrated reflectance panel before and after the flight, keep
the sun sensor on top of the aircraft unobstructed, and avoid flying while
light is changing. Bands must be radiometrically calibrated and aligned to
each other before indices are computed; uncalibrated NDVI between two dates is
not comparable.

## Flights for 3D and photorealistic models
Nadir-only grids reconstruct the ground well but leave depth poorly
constrained along the viewing direction, so 3D models and Gaussian splats look
best from above and degrade at grazing angles. Add oblique passes with the
camera tilted 35 to 45 degrees (a cross-hatch or an orbit around the field)
for models that hold up from any viewpoint. Trees at the field margin need
those obliques most.
