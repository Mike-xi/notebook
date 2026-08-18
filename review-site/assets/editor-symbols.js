// 站内 Markdown 编辑器的公式符号库（editor.html 用，见 editor.js 里的符号面板）。
//
// 每一项：
//   t   面板上显示的样子（用 KaTeX 渲染）
//   i   插进正文的 LaTeX，缺省同 t
//   sel 插入后要选中的那一小段（模板用：插完直接改这一段），可选
//   k   搜索关键字（中文名 / 英文名），面板顶部的搜索框按它匹配
//
// 分组按「写物理/数学作业时最常伸手的顺序」排：希腊字母 → 运算 → 关系 →
// 箭头 → 微积分 → 上下标与括号 → 矩阵环境 → 物理记号 → 常量与单位 → 常用公式。
// 最后两组是给大物和船海专业课准备的（雷诺数、傅汝德数、伯努利那些）。
(function () {
  const g = (t, k) => ({ t, k });

  window.NB_SYMBOLS = [
    {
      key: 'greek', name: '希腊字母',
      items: [
        g('\\alpha', 'alpha 阿尔法'), g('\\beta', 'beta 贝塔'), g('\\gamma', 'gamma 伽马'), g('\\delta', 'delta'),
        g('\\epsilon', 'epsilon'), g('\\varepsilon', 'varepsilon 介电'), g('\\zeta', 'zeta'), g('\\eta', 'eta 效率'),
        g('\\theta', 'theta 角'), g('\\vartheta', 'vartheta'), g('\\iota', 'iota'), g('\\kappa', 'kappa'),
        g('\\lambda', 'lambda 波长'), g('\\mu', 'mu 摩擦 粘度'), g('\\nu', 'nu 频率 运动粘度'), g('\\xi', 'xi'),
        g('\\pi', 'pi 圆周率'), g('\\rho', 'rho 密度'), g('\\sigma', 'sigma 应力'), g('\\tau', 'tau 切应力 时间常数'),
        g('\\upsilon', 'upsilon'), g('\\phi', 'phi 相位'), g('\\varphi', 'varphi'), g('\\chi', 'chi'),
        g('\\psi', 'psi 波函数'), g('\\omega', 'omega 角频率'),
        g('\\Gamma', 'Gamma 环量'), g('\\Delta', 'Delta 增量'), g('\\Theta', 'Theta'), g('\\Lambda', 'Lambda'),
        g('\\Xi', 'Xi'), g('\\Pi', 'Pi'), g('\\Sigma', 'Sigma 求和'), g('\\Upsilon', 'Upsilon'),
        g('\\Phi', 'Phi 磁通'), g('\\Psi', 'Psi'), g('\\Omega', 'Omega 欧姆 立体角'),
      ],
    },
    {
      key: 'op', name: '运算',
      items: [
        g('+', '加'), g('-', '减'), g('\\pm', '正负'), g('\\mp', '负正'),
        g('\\times', '乘 叉乘 cross'), g('\\div', '除'), g('\\cdot', '点乘 dot'), g('\\ast', '星号'),
        g('\\circ', '复合 度'), g('\\oplus', '直和'), g('\\otimes', '张量积'), g('\\odot', '哈达玛'),
        g('\\sum', '求和 sum'), g('\\prod', '连乘 product'), g('\\int', '积分 integral'), g('\\iint', '二重积分'),
        g('\\iiint', '三重积分'), g('\\oint', '环路积分 闭合'), g('\\partial', '偏导 partial'), g('\\nabla', '梯度 nabla 散度 旋度'),
        g('\\sqrt{x}', '根号 sqrt'), g('\\infty', '无穷 infinity'), g('\\%', '百分号'), g('\\pmod{n}', '取模'),
      ],
    },
    {
      key: 'rel', name: '关系',
      items: [
        g('=', '等于'), g('\\neq', '不等于'), g('\\approx', '约等于'), g('\\equiv', '恒等 全等'),
        g('\\sim', '相似'), g('\\simeq', '渐近等于'), g('\\cong', '全等'), g('\\propto', '正比 成正比'),
        g('<', '小于'), g('>', '大于'), g('\\leq', '小于等于'), g('\\geq', '大于等于'),
        g('\\ll', '远小于'), g('\\gg', '远大于'), g('\\in', '属于'), g('\\notin', '不属于'),
        g('\\subset', '真子集'), g('\\subseteq', '子集'), g('\\cup', '并集'), g('\\cap', '交集'),
        g('\\forall', '任意'), g('\\exists', '存在'), g('\\nexists', '不存在'), g('\\therefore', '所以'),
        g('\\because', '因为'), g('\\perp', '垂直'), g('\\parallel', '平行'), g('\\angle', '角'),
      ],
    },
    {
      key: 'arrow', name: '箭头',
      items: [
        g('\\to', '右箭头 趋于'), g('\\gets', '左箭头'), g('\\leftrightarrow', '双向'),
        g('\\Rightarrow', '推出 蕴含'), g('\\Leftarrow', '反推'), g('\\Leftrightarrow', '等价 当且仅当'),
        g('\\mapsto', '映射'), g('\\longrightarrow', '长右箭头'), g('\\rightleftharpoons', '可逆 平衡'),
        g('\\uparrow', '上'), g('\\downarrow', '下'), g('\\nearrow', '增'), g('\\searrow', '减'),
      ],
    },
    {
      key: 'calc', name: '微积分',
      items: [
        { t: '\\frac{a}{b}', i: '\\frac{a}{b}', sel: 'a', k: '分数 frac 分式' },
        { t: '\\frac{\\mathrm{d}y}{\\mathrm{d}x}', i: '\\frac{\\mathrm{d}y}{\\mathrm{d}x}', sel: 'y', k: '导数 derivative' },
        { t: '\\frac{\\partial f}{\\partial x}', i: '\\frac{\\partial f}{\\partial x}', sel: 'f', k: '偏导数 partial' },
        { t: '\\frac{\\mathrm{d}^2y}{\\mathrm{d}x^2}', i: '\\frac{\\mathrm{d}^2y}{\\mathrm{d}x^2}', sel: 'y', k: '二阶导数' },
        { t: '\\int_a^b f(x)\\,\\mathrm{d}x', i: '\\int_{a}^{b} f(x)\\,\\mathrm{d}x', sel: 'f(x)', k: '定积分 integral' },
        { t: '\\oint_C \\vec{F}\\cdot\\mathrm{d}\\vec{r}', i: '\\oint_{C} \\vec{F}\\cdot\\mathrm{d}\\vec{r}', sel: '\\vec{F}', k: '环路积分 线积分' },
        { t: '\\sum_{i=1}^{n} a_i', i: '\\sum_{i=1}^{n} a_i', sel: 'a_i', k: '求和 sum' },
        { t: '\\prod_{i=1}^{n} a_i', i: '\\prod_{i=1}^{n} a_i', sel: 'a_i', k: '连乘' },
        { t: '\\lim_{x \\to 0} f(x)', i: '\\lim_{x \\to 0} f(x)', sel: 'f(x)', k: '极限 limit' },
        { t: '\\iint_D f\\,\\mathrm{d}A', i: '\\iint_{D} f\\,\\mathrm{d}A', sel: 'f', k: '二重积分 面积分' },
        { t: '\\nabla\\cdot\\vec{F}', i: '\\nabla\\cdot\\vec{F}', sel: '\\vec{F}', k: '散度 divergence' },
        { t: '\\nabla\\times\\vec{F}', i: '\\nabla\\times\\vec{F}', sel: '\\vec{F}', k: '旋度 curl' },
      ],
    },
    {
      key: 'script', name: '上下标 · 括号',
      items: [
        { t: 'x^{2}', i: 'x^{2}', sel: '2', k: '上标 指数 平方' },
        { t: 'x_{i}', i: 'x_{i}', sel: 'i', k: '下标' },
        { t: 'x_{i}^{2}', i: 'x_{i}^{2}', sel: 'i', k: '上下标' },
        { t: '\\sqrt{x}', i: '\\sqrt{x}', sel: 'x', k: '根号' },
        { t: '\\sqrt[n]{x}', i: '\\sqrt[n]{x}', sel: 'x', k: 'n次根' },
        { t: '\\left( x \\right)', i: '\\left( x \\right)', sel: 'x', k: '自适应括号' },
        { t: '\\left[ x \\right]', i: '\\left[ x \\right]', sel: 'x', k: '方括号' },
        { t: '\\left\\{ x \\right\\}', i: '\\left\\{ x \\right\\}', sel: 'x', k: '花括号' },
        { t: '\\left| x \\right|', i: '\\left| x \\right|', sel: 'x', k: '绝对值 模' },
        { t: '\\left\\| \\vec{v} \\right\\|', i: '\\left\\| \\vec{v} \\right\\|', sel: '\\vec{v}', k: '范数 模长' },
        { t: '\\langle a, b \\rangle', i: '\\langle a, b \\rangle', sel: 'a', k: '内积 尖括号' },
        { t: '\\overline{x}', i: '\\overline{x}', sel: 'x', k: '平均 上划线' },
        { t: '\\underbrace{x}_{n}', i: '\\underbrace{x}_{n}', sel: 'x', k: '下花括号' },
        { t: '\\text{中文}', i: '\\text{中文}', sel: '中文', k: '公式里写文字 text' },
      ],
    },
    {
      key: 'matrix', name: '矩阵 · 环境',
      items: [
        { t: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', i: '\\begin{pmatrix}\n  a & b \\\\\n  c & d\n\\end{pmatrix}', sel: 'a', k: '圆括号矩阵' },
        { t: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}', i: '\\begin{bmatrix}\n  a & b \\\\\n  c & d\n\\end{bmatrix}', sel: 'a', k: '方括号矩阵' },
        { t: '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}', i: '\\begin{vmatrix}\n  a & b \\\\\n  c & d\n\\end{vmatrix}', sel: 'a', k: '行列式' },
        { t: '\\begin{cases} a & x>0 \\\\ b & x\\le 0 \\end{cases}', i: '\\begin{cases}\n  a & x > 0 \\\\\n  b & x \\le 0\n\\end{cases}', sel: 'a', k: '分段函数 方程组' },
        { t: '\\begin{aligned} a &= b \\\\ &= c \\end{aligned}', i: '\\begin{aligned}\n  a &= b \\\\\n    &= c\n\\end{aligned}', sel: 'a', k: '多行对齐 推导' },
      ],
    },
    {
      key: 'phys', name: '物理记号',
      items: [
        { t: '\\vec{v}', i: '\\vec{v}', sel: 'v', k: '矢量 向量' },
        { t: '\\hat{n}', i: '\\hat{n}', sel: 'n', k: '单位矢量 帽' },
        { t: '\\dot{x}', i: '\\dot{x}', sel: 'x', k: '一阶时间导数' },
        { t: '\\ddot{x}', i: '\\ddot{x}', sel: 'x', k: '二阶时间导数 加速度' },
        { t: '\\bar{x}', i: '\\bar{x}', sel: 'x', k: '平均值' },
        { t: '\\tilde{x}', i: '\\tilde{x}', sel: 'x', k: '波浪 近似' },
        { t: '\\mathbf{F}', i: '\\mathbf{F}', sel: 'F', k: '黑体 矢量' },
        { t: '\\Delta x', i: '\\Delta x', sel: 'x', k: '变化量 增量' },
        { t: '\\mathrm{d}x', i: '\\mathrm{d}x', sel: 'x', k: '微元 微分' },
        g('\\hbar', '约化普朗克常量'), g('\\ell', '长度 角动量量子数'),
        g('^\\circ', '度 角度'), g('{}^\\circ\\mathrm{C}', '摄氏度'),
        g('\\%', '百分号'), g('\\infty', '无穷'),
      ],
    },
    {
      key: 'unit', name: '常量 · 单位',
      items: [
        { t: 'c', i: 'c', k: '光速' }, { t: 'g', i: 'g', k: '重力加速度' },
        { t: 'G', i: 'G', k: '万有引力常量' }, { t: 'k_B', i: 'k_B', k: '玻尔兹曼常量' },
        { t: 'N_A', i: 'N_A', k: '阿伏伽德罗常数' }, { t: 'R', i: 'R', k: '气体常量' },
        { t: '\\varepsilon_0', i: '\\varepsilon_0', k: '真空介电常数' }, { t: '\\mu_0', i: '\\mu_0', k: '真空磁导率' },
        { t: '\\sigma', i: '\\sigma', k: '斯特藩玻尔兹曼 应力' }, { t: 'h', i: 'h', k: '普朗克常量' },
        { t: '\\mathrm{m/s}', i: '\\mathrm{m/s}', k: '速度单位' },
        { t: '\\mathrm{m/s^2}', i: '\\mathrm{m/s^2}', k: '加速度单位' },
        { t: '\\mathrm{N\\cdot m}', i: '\\mathrm{N\\cdot m}', k: '力矩单位' },
        { t: '\\mathrm{kg/m^3}', i: '\\mathrm{kg/m^3}', k: '密度单位' },
        { t: '\\mathrm{J}', i: '\\mathrm{J}', k: '焦耳' }, { t: '\\mathrm{W}', i: '\\mathrm{W}', k: '瓦特' },
        { t: '\\mathrm{Pa}', i: '\\mathrm{Pa}', k: '帕斯卡 压强' }, { t: '\\mathrm{Hz}', i: '\\mathrm{Hz}', k: '赫兹' },
        { t: '\\mathrm{K}', i: '\\mathrm{K}', k: '开尔文' }, { t: '\\Omega', i: '\\Omega', k: '欧姆' },
        { t: '\\mathrm{eV}', i: '\\mathrm{eV}', k: '电子伏' }, { t: '\\mathrm{kn}', i: '\\mathrm{kn}', k: '节 航速' },
      ],
    },
    {
      key: 'formula', name: '常用公式',
      wide: true,
      items: [
        { t: '\\vec{F} = m\\vec{a}', i: '\\vec{F} = m\\vec{a}', k: '牛顿第二定律' },
        { t: 'x = x_0 + v_0 t + \\tfrac{1}{2}at^2', i: 'x = x_0 + v_0 t + \\frac{1}{2} a t^2', k: '匀加速位移' },
        { t: 'W = \\int \\vec{F}\\cdot\\mathrm{d}\\vec{s}', i: 'W = \\int \\vec{F} \\cdot \\mathrm{d}\\vec{s}', k: '功' },
        { t: 'E_k = \\tfrac{1}{2}mv^2', i: 'E_k = \\frac{1}{2} m v^2', k: '动能' },
        { t: '\\omega = 2\\pi f', i: '\\omega = 2\\pi f', k: '角频率' },
        { t: 'T = 2\\pi\\sqrt{l/g}', i: 'T = 2\\pi\\sqrt{\\frac{l}{g}}', k: '单摆周期' },
        { t: 'pV = nRT', i: 'pV = nRT', k: '理想气体状态方程' },
        { t: '\\Delta S \\geq 0', i: '\\Delta S \\geq 0', k: '熵增原理 热二定律' },
        { t: '\\nabla\\cdot\\vec{E} = \\rho/\\varepsilon_0', i: '\\nabla \\cdot \\vec{E} = \\frac{\\rho}{\\varepsilon_0}', k: '高斯定律 麦克斯韦' },
        { t: '\\nabla\\times\\vec{B} = \\mu_0\\vec{J} + \\mu_0\\varepsilon_0\\tfrac{\\partial\\vec{E}}{\\partial t}', i: '\\nabla \\times \\vec{B} = \\mu_0 \\vec{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\vec{E}}{\\partial t}', k: '安培麦克斯韦定律' },
        { t: 'i\\hbar\\tfrac{\\partial}{\\partial t}\\psi = \\hat{H}\\psi', i: 'i\\hbar \\frac{\\partial}{\\partial t}\\psi = \\hat{H}\\psi', k: '薛定谔方程' },
        { t: 'E = mc^2', i: 'E = mc^2', k: '质能方程' },
        { t: 'p + \\tfrac{1}{2}\\rho v^2 + \\rho g h = C', i: 'p + \\frac{1}{2}\\rho v^2 + \\rho g h = \\mathrm{const}', k: '伯努利方程 流体' },
        { t: 'Re = \\dfrac{\\rho v L}{\\mu}', i: 'Re = \\frac{\\rho v L}{\\mu}', k: '雷诺数 流体' },
        { t: 'Fr = \\dfrac{v}{\\sqrt{gL}}', i: 'Fr = \\frac{v}{\\sqrt{gL}}', k: '傅汝德数 船舶' },
        { t: 'F_b = \\rho g V', i: 'F_b = \\rho g V', k: '浮力 阿基米德' },
      ],
    },
  ];
})();
