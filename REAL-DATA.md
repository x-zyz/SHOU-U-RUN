# 真实 GPS 数据采集（0.7.0）

点击“开始真实跑步”，允许精确位置；Android 13+ 另请求通知权限。GPS 需打开。在室外等待样本数增加后跑步。暂停会注销定位请求；结束会关闭文件并停止前台服务。锁屏期间使用位置类型前台服务和唤醒锁；厂商省电策略或强制停止仍可能中断，需真机验收。

文件保存在应用私有 real_runs 目录，每次新建文件，不上传。界面历史记录选择文件后通过系统文件选择器导出 JSONL。活动采集中或暂停中的当前文件需先结束再导出。卸载会删除应用内文件。异常进程终止后已 flush 的完整行保留；恢复界面显示中断，不擅自重新定位。导出最多 32 MB/文件。

## 数据格式
每行一个 JSON 对象。session 行包含 schema=shou.real-gps.v1、synthetic=false、source=android_gps、WGS84 坐标系、目标采样间隔和设备型号。该标记表示采集通道，不证明传感器定位未被模拟；fix.mock 单独保留系统模拟定位标记。

fix 行保留 Android Location 返回值：time_ms（UTC Unix 毫秒）、elapsed_ns（定位单调时钟纳秒）、received_time_ms/received_elapsed_ns（回调接收时间）、lat/lon、accuracy_m、altitude_m、speed_mps、bearing_deg、vertical_accuracy_m、speed_accuracy_mps、bearing_accuracy_deg、provider、mock。未提供的测量值写 null。目标 1000 ms 不保证每秒返回；不删异常点、不平滑、不吸附人行道、不插值补点。

另外保存 pause、resume、gps_disabled、completed、interrupted、error 事件。文件缺少结束事件时应视为不完整采集；训练导入可忽略末尾不完整 JSON 行，但必须记录该情况。

这是系统 GPS 定位样本，不是 GNSS 伪距等底层卫星观测数据。本版没有心率或步频传感器采集，不生成填充值。采集原始文件与模拟生成的 GPX/FIT 独立。

## 后续分析
先按 session 和 pause/resume 切分，不跨暂停累计运动。用 elapsed_ns 检查间隔和重排问题，不假设严格 1 Hz；缺失、重复、mock=true、低精度样本应在派生数据中标记，原文件保持不变。比较系统 speed_mps 与位置差分速度，结合 speed_accuracy_mps 与 accuracy_m 识别噪声。训练集与验证集按整次跑步分组，避免同一条轨迹泄漏。

本版只负责采集、保存和导出，没有自动拟合或训练模型。

Android 官方参考：https://developer.android.com/develop/background-work/services/fgs/service-types#location
权限：https://developer.android.com/develop/sensors-and-location/location/permissions/runtime
