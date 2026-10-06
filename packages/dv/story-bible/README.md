---
description: "Story bible component of DreamVerse: the dvStoryBible service, the bible reducer, and the six operations that create and update characters, locations and styles, with their agent tools."
kind: "package-reference"
---

# @dv/story-bible

English | [中文](README.zh.md)

## Summary

Use this package to keep the characters, locations and styles of a project, each with its reference images. It registers six operations with `dvProject`, a create and an update per kind (`bible.character_create`, `bible.character_update`, and the same for `location` and `style`), and the `bible` reducer that turns their records into versions. Each call writes the next version of an ID. A shot names a version as the input `<id>@<version>`, which stands for that version's reference images. An update makes every record that read the previous version stale.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after `@dv/project`. The component has no configuration fields.

```yaml
- id: dv-story-bible
  name: '@dv/story-bible'
```

| Operation | Tool | Inputs and params | Effect |
| --- | --- | --- | --- |
| `bible.<kind>_create` | `dv_bible_<kind>_create` | param `<kind>` (the ID, without `@` or `#`), `name`, `description`; input `reference` (images, several) | Version 1 of a new ID; fails when the ID already names a character, location or style |
| `bible.<kind>_update` | `dv_bible_<kind>_update` | param `<kind>` (the ID), `name`, `description`; input `reference` | The next version; keeps the name, description and reference images the call leaves out; fails for an unknown ID |

`<kind>` is `character`, `location` or `style`. The operations write no files (`outputs` is empty), take no confirmation, and are not deterministic, so the runner never reuses an earlier call instead of the ID checks. An update supersedes the record that wrote the previous version, so every record that read the previous version becomes stale.

The `bible` slice of `ProjectState` is `StoryBibleState`: `characters`, `locations` and `styles`, each a map from ID to the versions oldest first. A version (`Character`, `Location`, `Style`) has `id`, `version`, `name`, `description`, `references` (asset IDs) and `created_by` (the record that wrote it). The ID types `CharacterId`, `LocationId` and `StyleId` are defined in `@dv/project`, which types record inputs with them, and re-exported here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The reducer reads only finished `bible.*` records. A version's reference images are the resolved assets of the record's `reference` inputs, so the runner checks that they exist and the record lists them as what it read. Project calls three optional reducer members of the `bible` key: `assetsOf` resolves an `<id>@<version>` input to its reference images, `createdBy` names the record that wrote a version (Project treats it as the input's producer for stale marks and for parsing `<id>@<version>`), and `conflict` stops accept replay when `main` already has the ID a draft creates or lacks the ID a draft updates. Two drafts that update the same version meet Project's general check: both supersede the same record.

| File | Content |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `dvStoryBible`: the six operations and their ID checks |
| [`src/reducer.ts`](src/reducer.ts) | The `bible` reducer with `assetsOf`, `createdBy` and `conflict` |
| [`src/types.ts`](src/types.ts) | `Character`, `Location`, `Style`, `StoryBibleState` and the `ComponentStates` declaration |

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@dv/project`](../project/README.md): operations, reducers, stale marks and accept replay.
- [`COMPONENT-TEMPLATE.md`](../COMPONENT-TEMPLATE.md): the layout this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool definitions

#### What the model sees

Six tools, `dv_bible_character_create`, `dv_bible_character_update`, `dv_bible_location_create`, `dv_bible_location_update`, `dv_bible_style_create` and `dv_bible_style_update`, in the format `@dv/project` gives every operation tool. Each takes the ID under the kind's name (`character`, `location` or `style`), `name`, `description` ("Words carried into every prompt: wardrobe, mood, or look."), and `inputs.reference` with asset IDs. A create description says what the kind is, that a shot names it as the input `<character>@1`, and that the ID must not name another character, location or style; an update description says that the next version keeps what the call does not change and marks everything made with the previous version as stale.

#### Token effect

About 1,800 tokens for the six definitions, fixed while the plugin is mounted; the shared arguments of `@dv/project` add about 200 tokens to each definition.

#### KV Cache effect

The definitions sit in the stable tool section of every agent request; mounting or removing the plugin changes the tool list and invalidates the cached prefix from the tool section on.

### Tool results

#### What the model sees

A call returns one text block: `done <record>: character Lead created` (`character c1 updated` for an update) and the params. A refused ID returns a tool error that says why, such as "The ID 's1' already names a style; update it, or choose another ID." or "Unknown character 'c9'."

#### Token effect

About 50 tokens per call.

#### KV Cache effect

The result is appended to the conversation after the call; the cached prefix stays intact.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No delete**: a character, location or style stays in the project once created; an update can only change it.
