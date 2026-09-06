#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将经过 pepoafonso 调色板转换后的 PNG 图片转成 wplace.live 可用的模板 JSON。

用法:
    python convert_image_to_template.py

程序会以交互方式询问图片路径、坐标偏移和输出路径。
"""

import json
from pathlib import Path

try:
    from PIL import Image
except ImportError as exc:
    raise SystemExit("请先安装 Pillow: pip install Pillow") from exc


# wplace.live 官方 64 色调色板（索引 0 为透明）
PALETTE = [
    {"id": 0, "name": "Transparent", "hex": "transparent", "rgb": (0, 0, 0)},
    {"id": 1, "name": "Black", "hex": "#000000", "rgb": (0, 0, 0)},
    {"id": 2, "name": "Dark Gray", "hex": "#3C3C3C", "rgb": (60, 60, 60)},
    {"id": 3, "name": "Gray", "hex": "#787878", "rgb": (120, 120, 120)},
    {"id": 4, "name": "Light Gray", "hex": "#D2D2D2", "rgb": (210, 210, 210)},
    {"id": 5, "name": "White", "hex": "#FFFFFF", "rgb": (255, 255, 255)},
    {"id": 6, "name": "Deep Red", "hex": "#600018", "rgb": (96, 0, 24)},
    {"id": 7, "name": "Red", "hex": "#ED1C24", "rgb": (237, 28, 36)},
    {"id": 8, "name": "Orange", "hex": "#FF7F27", "rgb": (255, 127, 39)},
    {"id": 9, "name": "Gold", "hex": "#F6AA09", "rgb": (246, 170, 9)},
    {"id": 10, "name": "Yellow", "hex": "#F9DD3B", "rgb": (249, 221, 59)},
    {"id": 11, "name": "Light Yellow", "hex": "#FFFABC", "rgb": (255, 250, 188)},
    {"id": 12, "name": "Dark Green", "hex": "#0EB968", "rgb": (14, 185, 104)},
    {"id": 13, "name": "Green", "hex": "#13E67B", "rgb": (19, 230, 123)},
    {"id": 14, "name": "Light Green", "hex": "#87FF5E", "rgb": (135, 255, 94)},
    {"id": 15, "name": "Dark Teal", "hex": "#0C816E", "rgb": (12, 129, 110)},
    {"id": 16, "name": "Teal", "hex": "#10AEA6", "rgb": (16, 174, 166)},
    {"id": 17, "name": "Light Teal", "hex": "#13E1BE", "rgb": (19, 225, 190)},
    {"id": 18, "name": "Dark Blue", "hex": "#28509E", "rgb": (40, 80, 158)},
    {"id": 19, "name": "Blue", "hex": "#4093E4", "rgb": (64, 147, 228)},
    {"id": 20, "name": "Cyan", "hex": "#60F7F2", "rgb": (96, 247, 242)},
    {"id": 21, "name": "Indigo", "hex": "#6B50F6", "rgb": (107, 80, 246)},
    {"id": 22, "name": "Light Indigo", "hex": "#99B1FB", "rgb": (153, 177, 251)},
    {"id": 23, "name": "Dark Purple", "hex": "#780C99", "rgb": (120, 12, 153)},
    {"id": 24, "name": "Purple", "hex": "#AA38B9", "rgb": (170, 56, 185)},
    {"id": 25, "name": "Light Purple", "hex": "#E09FF9", "rgb": (224, 159, 249)},
    {"id": 26, "name": "Dark Pink", "hex": "#CB007A", "rgb": (203, 0, 122)},
    {"id": 27, "name": "Pink", "hex": "#EC1F80", "rgb": (236, 31, 128)},
    {"id": 28, "name": "Light Pink", "hex": "#F38DA9", "rgb": (243, 141, 169)},
    {"id": 29, "name": "Dark Brown", "hex": "#684634", "rgb": (104, 70, 52)},
    {"id": 30, "name": "Brown", "hex": "#95682A", "rgb": (149, 104, 42)},
    {"id": 31, "name": "Beige", "hex": "#F8B277", "rgb": (248, 178, 119)},
    {"id": 32, "name": "Medium Gray", "hex": "#AAAAAA", "rgb": (170, 170, 170)},
    {"id": 33, "name": "Dark Red", "hex": "#A50E1E", "rgb": (165, 14, 30)},
    {"id": 34, "name": "Light Red", "hex": "#FA8072", "rgb": (250, 128, 114)},
    {"id": 35, "name": "Dark Orange", "hex": "#E45C1A", "rgb": (228, 92, 26)},
    {"id": 36, "name": "Light Tan", "hex": "#D6B594", "rgb": (214, 181, 148)},
    {"id": 37, "name": "Dark Goldenrod", "hex": "#9C8431", "rgb": (156, 132, 49)},
    {"id": 38, "name": "Goldenrod", "hex": "#C5AD31", "rgb": (197, 173, 49)},
    {"id": 39, "name": "Light Goldenrod", "hex": "#E8D45F", "rgb": (232, 212, 95)},
    {"id": 40, "name": "Dark Olive", "hex": "#4A6B3A", "rgb": (74, 107, 58)},
    {"id": 41, "name": "Olive", "hex": "#5A944A", "rgb": (90, 148, 74)},
    {"id": 42, "name": "Light Olive", "hex": "#84C573", "rgb": (132, 197, 115)},
    {"id": 43, "name": "Dark Cyan", "hex": "#0F799F", "rgb": (15, 121, 159)},
    {"id": 44, "name": "Light Cyan", "hex": "#BBFAF2", "rgb": (187, 250, 242)},
    {"id": 45, "name": "Light Blue", "hex": "#7DC7FF", "rgb": (125, 199, 255)},
    {"id": 46, "name": "Dark Indigo", "hex": "#4D31B8", "rgb": (77, 49, 184)},
    {"id": 47, "name": "Dark Slate Blue", "hex": "#4A4284", "rgb": (74, 66, 132)},
    {"id": 48, "name": "Slate Blue", "hex": "#7A71C4", "rgb": (122, 113, 196)},
    {"id": 49, "name": "Light Slate Blue", "hex": "#B5AEF1", "rgb": (181, 174, 241)},
    {"id": 50, "name": "Light Brown", "hex": "#DBA463", "rgb": (219, 164, 99)},
    {"id": 51, "name": "Dark Beige", "hex": "#D18051", "rgb": (209, 128, 81)},
    {"id": 52, "name": "Light Beige", "hex": "#FFC5A5", "rgb": (255, 197, 165)},
    {"id": 53, "name": "Dark Peach", "hex": "#9B5249", "rgb": (155, 82, 73)},
    {"id": 54, "name": "Peach", "hex": "#D18078", "rgb": (209, 128, 120)},
    {"id": 55, "name": "Light Peach", "hex": "#FAB6A4", "rgb": (250, 182, 164)},
    {"id": 56, "name": "Dark Tan", "hex": "#7B6352", "rgb": (123, 99, 82)},
    {"id": 57, "name": "Tan", "hex": "#9C846B", "rgb": (156, 132, 107)},
    {"id": 58, "name": "Dark Slate", "hex": "#333941", "rgb": (51, 57, 65)},
    {"id": 59, "name": "Slate", "hex": "#6D758D", "rgb": (109, 117, 141)},
    {"id": 60, "name": "Light Slate", "hex": "#B3B9D1", "rgb": (179, 185, 209)},
    {"id": 61, "name": "Dark Stone", "hex": "#6D643F", "rgb": (109, 100, 63)},
    {"id": 62, "name": "Stone", "hex": "#948C6B", "rgb": (148, 140, 107)},
    {"id": 63, "name": "Light Stone", "hex": "#CDC59E", "rgb": (205, 197, 158)},
]


def hex_to_rgb(hex_color: str):
    """将 #RRGGBB 转成 (R, G, B)。"""
    if hex_color == "transparent":
        return (0, 0, 0)
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i : i + 2], 16) for i in (0, 2, 4))


def nearest_color_id(rgba: tuple[int, int, int, int]) -> int:
    """返回与给定 RGBA 最接近的调色板颜色索引；透明像素返回 0。"""
    r, g, b, a = rgba
    if a < 128:
        return 0

    best_id = 1
    best_dist = float("inf")
    for color in PALETTE[1:]:
        cr, cg, cb = color["rgb"]
        dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if dist < best_dist:
            best_dist = dist
            best_id = color["id"]
    return best_id


def convert(image_path: Path, offset_x: int, offset_y: int):
    """读取图片并生成模板字典。"""
    img = Image.open(image_path).convert("RGBA")
    width, height = img.size

    pixels = []
    for y in range(height):
        for x in range(width):
            color_id = nearest_color_id(img.getpixel((x, y)))
            if color_id == 0:
                continue
            color = PALETTE[color_id]
            pixels.append(
                {
                    "x": offset_x + x,
                    "y": offset_y + y,
                    "colorId": color_id,
                    "colorHex": color["hex"],
                }
            )

    return {
        "name": image_path.stem,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "width": width,
        "height": height,
        "pixelCount": len(pixels),
        "pixels": pixels,
    }


def ask_int(prompt, default=None):
    """交互式读取整数，支持默认值。"""
    while True:
        text = input(prompt).strip()
        if text == "" and default is not None:
            return default
        try:
            return int(text)
        except ValueError:
            print("请输入有效的整数。")


def ask_path(prompt, must_exist=False, default=None):
    """交互式读取文件路径，支持默认值和存在性校验。"""
    while True:
        text = input(prompt).strip().strip('"')
        if text == "" and default is not None:
            path = Path(default)
        else:
            path = Path(text)
        if must_exist and not path.exists():
            print(f"找不到文件：{path}，请重新输入。")
            continue
        return path


TILE_SIZE = 1000


def ask_choice(prompt, choices, default=None):
    """交互式选择，choices 为 {key: label} 字典。"""
    while True:
        text = input(prompt).strip()
        if text == "" and default is not None:
            return default
        if text in choices:
            return text
        print(f"请输入 {', '.join(choices.keys())} 之一。")


def ask_tile_pixel_coords():
    """以网站上显示的 (Tl X, Tl Y, Px X, Px Y) 形式读取左上角坐标。
    返回 (offset_x, offset_y, tl_x, tl_y, px_x, px_y)。"""
    print()
    print("请输入图片左上角在网站上的坐标（例如：Tl X: 1647, Tl Y: 838, Px X: 472, Px Y: 307）")
    tl_x = ask_int("Tl X：")
    tl_y = ask_int("Tl Y：")
    px_x = ask_int("Px X：")
    px_y = ask_int("Px Y：")
    offset_x = tl_x * TILE_SIZE + px_x
    offset_y = tl_y * TILE_SIZE + px_y
    return offset_x, offset_y, tl_x, tl_y, px_x, px_y


def ask_global_coords():
    """以全局像素坐标读取左上角偏移。"""
    print()
    print("wplace.live 当前赛季全局像素坐标范围：0 ~ 2,048,000")
    offset_x = ask_int("请输入左上角 X 偏移（offset-x）：", default=0)
    offset_y = ask_int("请输入左上角 Y 偏移（offset-y）：", default=0)
    return offset_x, offset_y


def main():
    print("=" * 50)
    print(" wplace.live 模板 JSON 生成工具")
    print("=" * 50)
    print()
    print("说明：")
    print("1. 请先用 pepoafonso 转换器得到调色板匹配后的 PNG。")
    print("2. 输入图片左上角在 wplace 中的坐标。")
    print("3. 程序会输出 template.json，供油猴脚本加载。")
    print()

    image_path = ask_path("请输入 PNG 图片路径：", must_exist=True)

    print()
    coord_mode = ask_choice(
        "请选择坐标输入方式（1: 瓦片+像素, 2: 全局像素）：",
        {"1": "瓦片+像素", "2": "全局像素"},
        default="1",
    )

    if coord_mode == "1":
        offset_x, offset_y, tl_x, tl_y, px_x, px_y = ask_tile_pixel_coords()
    else:
        offset_x, offset_y = ask_global_coords()
        tl_x = offset_x // TILE_SIZE
        tl_y = offset_y // TILE_SIZE
        px_x = offset_x % TILE_SIZE
        px_y = offset_y % TILE_SIZE

    default_output = image_path.with_suffix(".json")
    output_path = ask_path(
        f"请输入输出 JSON 路径（直接回车使用默认值 {default_output}）：",
        default=default_output,
    )

    # 确认步骤
    print()
    print("=" * 50)
    print(" 请确认以下输入信息：")
    print("=" * 50)
    print(f"  图片路径：{image_path}")
    print(f"  坐标模式：{'瓦片+像素' if coord_mode == '1' else '全局像素'}")
    print(f"  Tl X: {tl_x}, Tl Y: {tl_y}, Px X: {px_x}, Px Y: {px_y}")
    print(f"  全局偏移：offsetX={offset_x}, offsetY={offset_y}")
    print(f"  输出路径：{output_path}")
    print()
    confirm = input("输入 yes 继续，其他任意键取消：").strip().lower()
    if confirm != "yes":
        print("已取消。")
        return

    print()
    print("正在生成模板，请稍候...")
    template = convert(image_path, offset_x, offset_y)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(template, f, ensure_ascii=False, indent=2)

    print()
    print("✅ 已生成模板：")
    print(f"  文件：{output_path}")
    print(f"  图片尺寸：{template['width']} x {template['height']}")
    print(f"  全局左上角偏移：({template['offsetX']}, {template['offsetY']})")
    print(f"  非透明像素数：{template['pixelCount']}")
    print()
    print("提示：在网站上这个坐标对应：")
    print(
        f"  Tl X: {template['offsetX'] // TILE_SIZE}, "
        f"Tl Y: {template['offsetY'] // TILE_SIZE}, "
        f"Px X: {template['offsetX'] % TILE_SIZE}, "
        f"Px Y: {template['offsetY'] % TILE_SIZE}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print()
        print(f"❌ 出错：{exc}")
    finally:
        print()
        input("按回车键退出...")
