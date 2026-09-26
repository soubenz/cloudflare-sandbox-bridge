"""The document corpus for this lab: a small houseplant-care FAQ.

Each entry is (id, text). Ids are short, stable slugs so a learner (and the
grader) can talk about "which document came back" without quoting whole
paragraphs.
"""

DOCUMENTS = [
    ("watering-succulents", "Water succulents only when the soil is completely dry, roughly every two to three weeks. Overwatering is the most common way succulents die, since their thick leaves already store water."),
    ("watering-ferns", "Ferns like consistently moist soil and high humidity. Water a fern whenever the top inch of soil feels dry, and mist the leaves a few times a week if your air is dry."),
    ("watering-orchids", "Orchids prefer to dry out slightly between waterings. Water an orchid about once a week by soaking the roots, then let all the excess water drain away completely."),
    ("watering-snake-plant", "Snake plants are extremely drought tolerant. Water a snake plant every three to four weeks, less in winter, and always let the soil dry out fully first."),
    ("watering-pothos", "Pothos is forgiving about watering. Water your pothos when the top two inches of soil are dry, usually once a week, and reduce watering in the colder months."),
    ("light-succulents", "Succulents need bright light, ideally several hours of direct sun each day. A south-facing windowsill is usually the best spot for them indoors."),
    ("light-ferns", "Ferns prefer indirect, filtered light and can scorch in direct sun. An east-facing window or a spot a few feet back from a bright window works well."),
    ("light-orchids", "Orchids do best in bright, indirect light. Direct afternoon sun can burn their leaves, so an east or north-facing window is usually ideal."),
    ("light-snake-plant", "Snake plants tolerate almost any light level, from bright indirect light to fairly deep shade, though they grow fastest in medium to bright indirect light."),
    ("light-pothos", "Pothos grows well in low to bright indirect light, making it one of the most forgiving houseplants for a room without much natural sun."),
    ("repotting-basics", "Repot most houseplants every one to two years, or when roots start growing out of the drainage holes. Move up only one pot size at a time to avoid waterlogged soil."),
    ("repotting-succulents", "Repot succulents in spring using a fast-draining cactus mix. Let the plant sit dry for a couple of days before repotting so any broken roots can callus over."),
    ("repotting-orchids", "Repot orchids every one to two years in fresh orchid bark, not regular potting soil, since orchid roots need much more airflow than typical houseplant roots."),
    ("pests-spider-mites", "Spider mites show up as fine webbing and tiny speckled dots on leaves, especially in dry indoor air. Rinse leaves with water and raise humidity to discourage them."),
    ("pests-mealybugs", "Mealybugs look like small white cottony clumps in leaf joints. Dab them with a cotton swab dipped in rubbing alcohol, and repeat every few days until they are gone."),
    ("pests-fungus-gnats", "Fungus gnats breed in consistently damp potting soil. Letting the top inch of soil dry out fully between waterings is usually enough to break their breeding cycle."),
    ("humidity-tropical", "Tropical plants like ferns and orchids appreciate humidity above fifty percent. A pebble tray, a small humidifier, or grouping plants together all raise local humidity."),
    ("humidity-general", "Most homes run drier than tropical plants prefer, especially with indoor heating in winter. Brown, crispy leaf edges are a common sign that humidity is too low."),
    ("fertilizing-basics", "Fertilize most houseplants monthly during spring and summer with a diluted balanced houseplant fertilizer, and stop fertilizing in fall and winter while growth slows."),
    ("fertilizing-succulents", "Succulents need very little fertilizer. Feed them at most once or twice during the growing season with a diluted cactus fertilizer, since too much encourages weak, leggy growth."),
    ("propagation-pothos", "Pothos propagates easily from stem cuttings placed in water. Cut just below a node, keep the cutting in fresh water until roots appear, then pot it in soil."),
    ("propagation-succulents", "Many succulents propagate from a single healthy leaf. Let the leaf callus for a couple of days, then lay it on top of well-draining soil until it grows tiny roots."),
    ("soil-drainage", "Nearly every houseplant problem traces back to drainage. Use a pot with a drainage hole and a mix suited to the plant, since waterlogged roots rot even in otherwise good light."),
    ("temperature-general", "Most common houseplants are happiest between 65 and 75 degrees Fahrenheit and dislike cold drafts near doors and windows or hot air blowing directly from a heating vent."),
]
