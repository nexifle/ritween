# Ritween

<!-- impeccable:product-schema 1 -->

## Platform

Web.

## Stack

React, TypeScript, Vite, Tailwind CSS arbitrary classes. Native WebGPU, WebCodecs, custom TypeScript MP4 muxer.

## Purpose

External AI coding agents author source files; people preview, seek, and export compositions. No integrated AI, video editing tools, backend, or multimedia libraries.

## Success

An eight-second, three-scene composition previews deterministically and exports 240 H.264 frames at 30 FPS, with separate audio tracks mixed to AAC, to a playable, seekable MP4.

## Constraints

Scene modules own GPU rendering. The interface only previews and exports. Complex React state uses useReducer.
