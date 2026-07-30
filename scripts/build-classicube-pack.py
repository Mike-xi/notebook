#!/usr/bin/env python3
"""把 PixelPerfectionCE 的方块贴图拼成 ClassiCube 需要的 terrain.png，产出 default.zip。

为什么需要这个：ClassiCube 官方的 default.zip 里是 Minecraft 原版素材（Mojang 版权），
不能重新分发到公开站点上。PixelPerfectionCE 是 CC-BY-SA 4.0 且明确禁止收录原版素材，
所以可以合法替换。

terrain.png 是 16x16 格的图集，每格 16x16 像素。哪一格对应哪个方块，
来自 ClassiCube 源码 src/Block.c 里的 core_blockDefs[] 表（topTexture/sideTexture/bottomTexture 列）。

用法：
    python build-classicube-pack.py <工作目录>

工作目录下需要准备：
    default/    官方 default.zip 解压出来的内容（只用于采样颜色，不会被分发）
    ppce/PixelPerfectionCE-master/assets/minecraft/textures/...
输出：
    <工作目录>/default.zip

素材来源：
    https://www.classicube.net/static/default.zip
    https://github.com/Athemis/PixelPerfectionCE/archive/refs/heads/master.zip
"""
import os, sys, zipfile, shutil
from PIL import Image

TILE = 16
GRID = 16

# tile 索引 -> (PixelPerfection 相对路径, 处理方式)
#   ''       直接用
#   'frame0' 竖向动画条，取第一帧
#   'grass'/'leaf'/'wool'/'side'  从官方图集同一格采样颜色后做色相迁移
MAP = {
    0:  ('block/grass_block_top.png',        'grass'),
    1:  ('block/stone.png',                  ''),
    2:  ('block/dirt.png',                   ''),
    3:  ('block/grass_block_side.png',       'side'),
    4:  ('block/oak_planks.png',             ''),
    5:  ('block/smooth_stone_slab_side.png', ''),
    6:  ('block/smooth_stone.png',           ''),
    7:  ('block/bricks.png',                 ''),
    8:  ('block/tnt_side.png',               ''),
    9:  ('block/tnt_top.png',                ''),
    10: ('block/tnt_bottom.png',             ''),
    11: ('block/ladder.png',                 ''),      # Classic 的 rope，现代版没有对应
    12: ('block/poppy.png',                  ''),
    13: ('block/dandelion.png',              ''),
    14: ('block/water_still.png',            'frame0'),
    15: ('block/oak_sapling.png',            ''),
    16: ('block/cobblestone.png',            ''),
    17: ('block/bedrock.png',                ''),
    18: ('block/sand.png',                   ''),
    19: ('block/gravel.png',                 ''),
    20: ('block/oak_log.png',                ''),
    21: ('block/oak_log_top.png',            ''),
    22: ('block/oak_leaves.png',             'leaf'),
    23: ('block/iron_block.png',             ''),
    24: ('block/gold_block.png',             ''),
    25: ('block/sandstone_top.png',          ''),
    26: ('block/quartz_pillar_top.png',      ''),
    28: ('block/red_mushroom.png',           ''),
    29: ('block/brown_mushroom.png',         ''),
    30: ('block/lava_still.png',             'frame0'),
    32: ('block/gold_ore.png',               ''),
    33: ('block/iron_ore.png',               ''),
    34: ('block/coal_ore.png',               ''),
    35: ('block/bookshelf.png',              ''),
    36: ('block/mossy_cobblestone.png',      ''),
    37: ('block/obsidian.png',               ''),
    38: ('block/fire_0.png',                 'frame0'),
    39: ('block/iron_block.png',             ''),
    40: ('block/gold_block.png',             ''),
    41: ('block/sandstone.png',              ''),
    42: ('block/quartz_pillar.png',          ''),
    48: ('block/sponge.png',                 ''),
    49: ('block/glass.png',                  ''),
    50: ('block/snow.png',                   ''),
    51: ('block/ice.png',                    ''),
    52: ('block/stone_bricks.png',           ''),
    53: ('block/barrel_side.png',            ''),      # Classic 的 crate
    54: ('block/quartz_block_bottom.png',    ''),      # Classic 的 ceramic tile
    55: ('block/iron_block.png',             ''),
    56: ('block/gold_block.png',             ''),
    57: ('block/sandstone_bottom.png',       ''),
    58: ('block/quartz_pillar_top.png',      ''),
    86: ('block/magma.png',                  ''),
}
# 64..84 是 Classic 的 21 种颜色方块。现代版只有 16 色羊毛，直接映射会撞色，
# 所以统一用 white_wool 的纹理，颜色从官方图集对应格采样迁移。
for _t in range(64, 85):
    MAP[_t] = ('block/white_wool.png', 'wool')


def avg_color(im):
    px = im.load(); r = g = b = n = 0
    for y in range(im.height):
        for x in range(im.width):
            c = px[x, y]
            if c[3] > 32:
                r += c[0]; g += c[1]; b += c[2]; n += 1
    return (r // n, g // n, b // n) if n else (255, 255, 255)


def tint(im, target):
    """保留纹理明暗关系，把整体色相换成 target"""
    src = avg_color(im)
    px = im.load()
    out = Image.new('RGBA', im.size); op = out.load()
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            op[x, y] = (min(255, int(r * target[0] / max(1, src[0]))),
                        min(255, int(g * target[1] / max(1, src[1]))),
                        min(255, int(b * target[2] / max(1, src[2]))), a)
    return out


def main(base):
    pp = os.path.join(base, 'ppce', 'PixelPerfectionCE-master', 'assets', 'minecraft', 'textures')
    orig_dir = os.path.join(base, 'default')
    out_dir = os.path.join(base, 'pack')
    orig_terrain = os.path.join(orig_dir, 'terrain.png')

    for p in (pp, orig_terrain):
        if not os.path.exists(p):
            print('missing:', p); return 1

    def load(rel):
        p = os.path.join(pp, rel.replace('/', os.sep))
        return Image.open(p).convert('RGBA') if os.path.exists(p) else None

    orig = Image.open(orig_terrain).convert('RGBA')
    osz = orig.width // GRID
    atlas = Image.new('RGBA', (TILE * GRID, TILE * GRID), (0, 0, 0, 0))
    missing, done = [], 0

    for idx, (rel, mode) in sorted(MAP.items()):
        im = load(rel)
        if im is None:
            missing.append((idx, rel)); continue
        if mode == 'frame0':
            im = im.crop((0, 0, im.width, im.width))
        if im.size != (TILE, TILE):
            im = im.resize((TILE, TILE), Image.NEAREST)

        if mode in ('grass', 'leaf', 'wool', 'side'):
            ox, oy = (idx % GRID) * osz, (idx // GRID) * osz
            target = avg_color(orig.crop((ox, oy, ox + osz, oy + osz)))
            if mode == 'side':
                ov = load('block/grass_block_side_overlay.png')
                if ov is not None:
                    if ov.size != (TILE, TILE):
                        ov = ov.resize((TILE, TILE), Image.NEAREST)
                    im = im.copy(); im.alpha_composite(tint(ov, target))
                else:
                    im = tint(im, target)
            else:
                im = tint(im, target)

        atlas.paste(im, ((idx % GRID) * TILE, (idx // GRID) * TILE))
        done += 1

    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(orig_dir):                     # GUI 等 ClassiCube 自有素材保持原样
        shutil.copy2(os.path.join(orig_dir, f), os.path.join(out_dir, f))
    atlas.save(os.path.join(out_dir, 'terrain.png'))

    for rel, dst in (('font/ascii.png', 'default.png'), ('entity/steve.png', 'char.png')):
        im = load(rel)
        if im is not None:
            im.save(os.path.join(out_dir, dst))
            print('replaced %s -> %s' % (rel, dst))

    zpath = os.path.join(base, 'default.zip')
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(out_dir)):
            z.write(os.path.join(out_dir, f), f)

    print('tiles: %d/%d' % (done, len(MAP)))
    for i, r in missing:
        print('  MISSING tile %-3d %s' % (i, r))
    print('-> %s (%d bytes)' % (zpath, os.path.getsize(zpath)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '.'))
